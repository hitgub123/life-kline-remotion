#!/usr/bin/env node
/**
 * 一键生产：给一个人名，跑完 取材 → 生成 → 审查 → 渲染 → 配音 → 合成 全程。
 * 这是给「人或 agent」调用的入口：使用者只需给名字（和英文 id），中间步骤
 * 全部由本工具串联；已完成的步骤会自动跳过，失败后重跑会从断点继续。
 *
 * 用法:
 *   node tools/produce.mjs "辛弃疾" --id XinQiji
 *   node tools/produce.mjs "辛弃疾" --id XinQiji --bgm ~/音乐/某首.mp3
 *   node tools/produce.mjs "辛弃疾" --id XinQiji --skip-review --force
 *
 * 环境变量: GEMINI_API_KEY（生成/审查）, DEEPSEEK_API_KEY（审查异源，优先）,
 * 本机需装好 edge-tts（配音）。BGM 不给 --bgm 时：先出带配音的成片，并打印
 * 音乐提示词与补混命令，等曲子下载好后一条命令补上（不用重渲）。
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const id = flag("id", null);
const provider = flag("provider", "gemini");
const bgm = flag("bgm", null);
const bgmOffset = flag("bgm-offset", null);
const force = args.includes("--force");
const skipReview = args.includes("--skip-review");
const skipVoice = args.includes("--skip-voice");
if (!name || !id || !/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
  console.error('用法: node tools/produce.mjs "人名" --id EnglishId [--bgm 曲.mp3] [--provider gemini] [--skip-review] [--force]');
  console.error("（id 由调用者给：人物姓名的拼音连写，如 SuShi / XinQiji）");
  process.exit(1);
}
const base = id.toLowerCase();
const scriptRel = `src/data/${base}.json`;
const scriptPath = join(ROOT, scriptRel);
const videoPath = join(ROOT, "out", `${base}.mp4`);
const voicePath = join(ROOT, "out", `${base}-voice.wav`);
const finalPath = join(ROOT, "out", `${base}-final.mp4`);

function run(label, cmd, cmdArgs) {
  console.log(`\n=== ${label} ===`);
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT });
}
function tryRun(label, cmd, cmdArgs) {
  try {
    run(label, cmd, cmdArgs);
    return true;
  } catch {
    console.warn(`⚠ ${label}失败，继续后续步骤（可单独重跑该步）`);
    return false;
  }
}

// 1 取材
if (!existsSync(join(ROOT, "src/data/people", base + ".md")) || force)
  run("1/6 取材（维基百科）", "node", ["tools/fetch-person.mjs", name, "--id", id, ...(force ? ["--force"] : [])]);
else console.log("=== 1/6 取材：已有资料，跳过 ===");

// 2 生成
if (!existsSync(scriptPath) || force)
  run("2/6 生成脚本", "node", ["tools/generate-script.mjs", name, "--id", id, "--provider", provider]);
else console.log("=== 2/6 生成脚本：已存在，跳过 ===");

// 3 审查
let reviewed = false;
if (!skipReview) reviewed = tryRun("3/6 事实核查（异源模型）", "node", ["tools/fact-check.mjs", scriptRel]);
else console.log("=== 3/6 事实核查：按要求跳过 ===");

// 4 渲染
const stale = existsSync(videoPath) && existsSync(scriptPath) && statSync(videoPath).mtimeMs < statSync(scriptPath).mtimeMs;
if (!existsSync(videoPath) || force || stale) {
  console.log("\n=== 4/6 渲染视频 ===");
  execSync(`npx remotion render ${id} out/${base}.mp4`, { stdio: "inherit", cwd: ROOT });
} else console.log("=== 4/6 渲染：成片已是最新，跳过 ===");

// 5 配音
let voiceMade = existsSync(voicePath) && !force;
if (!skipVoice && !voiceMade)
  voiceMade = tryRun("5/6 生成头尾配音", "node", [
    "tools/make-voice.mjs", scriptRel, "--video", `out/${base}.mp4`, "--out", `out/${base}-voice.wav`,
  ]);
if (skipVoice) console.log("=== 5/6 配音：按要求跳过 ===");

// 6 合成
const mixArgs = [`out/${base}.mp4`, "--out", `out/${base}-final.mp4`];
if (bgm) {
  mixArgs.push("--bgm", bgm);
  if (bgmOffset) mixArgs.push("--bgm-offset", bgmOffset);
}
if (voiceMade) mixArgs.push("--voice", `out/${base}-voice.wav`);
if (bgm || voiceMade) run("6/6 合成", "node", ["tools/mix-audio.mjs", ...mixArgs]);
else console.log("=== 6/6 合成：无配音无 BGM，最终产物即渲染文件 ===");

const finalVideo = bgm || voiceMade ? finalPath : videoPath;
const s = JSON.parse(readFileSync(scriptPath, "utf8"));
console.log(`
──────── 生产小结 ────────
人物：${s.subject.name}（${s.subject.birth_year} 年生）
模板：${s.template || "classic"}　配音音色：${s.voice?.style || "无"}　BGM 风格：${s.bgm_style || "-"}
事实核查：${s.factcheck ? `${s.factcheck.verdict}（${s.factcheck.by}，问题 ${s.factcheck.issues} 处，详见 src/data/people/${base}.review.md）` : reviewed ? "已审查" : "未审查"}
产物：${finalVideo.replace(ROOT + "/", "")}${bgm ? "" : "\n（还没配 BGM：曲子下载好后跑下一行补混，不用重渲）"}`);
if (!bgm) {
  console.log(`音乐提示词: node tools/music-prompt.mjs ${scriptRel}`);
  console.log(`补混命令:   node tools/mix-audio.mjs out/${base}.mp4 --bgm <曲子文件>${voiceMade ? ` --voice out/${base}-voice.wav` : ""} --out out/${base}-final.mp4`);
}
