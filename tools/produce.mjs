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
 * 本机需装好 edge-tts（配音）。BGM 不给 --bgm 时：按脚本 bgm_style 从曲库
 * 自动选曲（tools/pick-bgm.mjs，登记表里 auto 的曲目）直接混成最终版；
 * 曲库无候选才打印音乐提示词与补混命令，等人工送歌。--no-auto-bgm 关掉自动选曲。
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickBgm } from "./pick-bgm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 与 agent 共用仓库根目录的 .env（已在环境变量里的优先，不覆盖）
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

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
const noAutoBgm = args.includes("--no-auto-bgm");
if (!name || !id || !/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
  console.error('用法: node tools/produce.mjs "人名" --id EnglishId [--bgm 曲.mp3] [--provider gemini] [--skip-review] [--force]');
  console.error("（id 由调用者给：人物姓名的拼音连写，如 SuShi / XinQiji）");
  process.exit(1);
}
// 选题黑名单硬拦截：敏感人物在生产入口直接挡下（Discord 与命令行都走这里，防绕过选题工具直接下单）。
// 命中名字（含别名）或 id 即拒绝；要放行某人，改 tools/topic-blacklist.json。
{
  const blFile = join(ROOT, "tools/topic-blacklist.json");
  if (existsSync(blFile)) {
    try {
      const bl = JSON.parse(readFileSync(blFile, "utf8"));
      const hit = (bl.entries || []).find(
        (e) => e.name === name || (e.aliases || []).includes(name) || (e.id || "").toLowerCase() === id.toLowerCase()
      );
      if (hit) {
        console.error(`⛔「${name}」在选题黑名单内（${hit.category}），敏感人物不生产。名单：tools/topic-blacklist.json`);
        process.exit(1);
      }
    } catch {}
  }
}
const base = id.toLowerCase();
const scriptRel = `src/data/${base}.json`;
const scriptPath = join(ROOT, scriptRel);
const videoPath = join(ROOT, "out", `${base}.mp4`);
const voicePath = join(ROOT, "out", `${base}-voice.wav`);
const finalPath = join(ROOT, "out", `${base}-final.mp4`);

// 运行日志：全程输出（每步标题+子工具输出+小结）同步落盘到 out/logs/，
// 事后可查「哪一步发生了什么」；小结里会打印日志路径，agent 转达时也能看到。
const logsDir = join(ROOT, "out", "logs");
mkdirSync(logsDir, { recursive: true });
const _d = new Date();
const _pad = (n) => String(n).padStart(2, "0");
const logPath = join(
  logsDir,
  `${base}-${_d.getFullYear()}${_pad(_d.getMonth() + 1)}${_pad(_d.getDate())}-${_pad(_d.getHours())}${_pad(_d.getMinutes())}${_pad(_d.getSeconds())}.log`
);
const logStream = createWriteStream(logPath, { flags: "a" });
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
console.log = (...a) => { _log(...a); logStream.write(a.join(" ") + "\n"); };
console.warn = (...a) => { _warn(...a); logStream.write(a.join(" ") + "\n"); };

function runCmd(label, cmd, cmdArgs, { shell = false } = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${label} ===`);
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, shell });
    const onData = (d) => { process.stdout.write(d); logStream.write(d); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} 失败（exit ${code}）`))));
  });
}
async function run(label, cmd, cmdArgs, opts) {
  await runCmd(label, cmd, cmdArgs, opts);
}
async function tryRun(label, cmd, cmdArgs, opts) {
  try {
    await runCmd(label, cmd, cmdArgs, opts);
    return true;
  } catch {
    console.warn(`⚠ ${label}失败，继续后续步骤（可单独重跑该步）`);
    return false;
  }
}

// 1 取材
if (!existsSync(join(ROOT, "src/data/people", base + ".md")) || force)
  await run("1/6 取材（维基百科）", "node", ["tools/fetch-person.mjs", name, "--id", id, ...(force ? ["--force"] : [])]);
else console.log("=== 1/6 取材：已有资料，跳过 ===");

// 2 生成
if (!existsSync(scriptPath) || force)
  await run("2/6 生成脚本", "node", ["tools/generate-script.mjs", name, "--id", id, "--provider", provider]);
else console.log("=== 2/6 生成脚本：已存在，跳过 ===");

// 3 审查（失败不拦生产，但状态会带进小结，成片未审必须一眼可见）
let reviewState = "skipped";
if (!skipReview) reviewState = (await tryRun("3/6 事实核查（异源模型）", "node", ["tools/fact-check.mjs", scriptRel])) ? "done" : "failed";
else console.log("=== 3/6 事实核查：按要求跳过 ===");

// 4 渲染
const stale = existsSync(videoPath) && existsSync(scriptPath) && statSync(videoPath).mtimeMs < statSync(scriptPath).mtimeMs;
if (!existsSync(videoPath) || force || stale) {
  await run("4/6 渲染视频", "npx", ["remotion", "render", id, `out/${base}.mp4`], { shell: process.platform === "win32" });
} else console.log("=== 4/6 渲染：成片已是最新，跳过 ===");

// 5 配音
let voiceMade = existsSync(voicePath) && !force;
if (!skipVoice && !voiceMade)
  voiceMade = await tryRun("5/6 生成头尾配音", "node", [
    "tools/make-voice.mjs", scriptRel, "--video", `out/${base}.mp4`, "--out", `out/${base}-voice.wav`,
  ]);
if (skipVoice) console.log("=== 5/6 配音：按要求跳过 ===");

// 选曲：手动 --bgm 优先；否则按脚本风格从曲库自动选；--no-auto-bgm 关掉自动
let bgmPath = bgm;
let bgmPick = null;
if (!bgmPath && !noAutoBgm) {
  try {
    bgmPick = pickBgm(ROOT, JSON.parse(readFileSync(scriptPath, "utf8")), base);
  } catch {}
  if (bgmPick) {
    bgmPath = join("assets", "bgm", bgmPick.file);
    console.log(`\n=== 自动选曲：${bgmPick.file}（风格 ${bgmPick.style}${bgmPick.fallback ? "，原风格无候选、回退默认风格" : ""}，高潮 ${bgmPick.climaxAt ?? "?"}s，候选 ${bgmPick.candidates} 首）===`);
  } else console.log("\n=== 自动选曲：曲库无候选，留待补混 ===");
}

// 6 合成
const mixArgs = [`out/${base}.mp4`, "--out", `out/${base}-final.mp4`];
if (bgmPath) {
  mixArgs.push("--bgm", bgmPath);
  if (bgmOffset) mixArgs.push("--bgm-offset", bgmOffset);
}
if (voiceMade) mixArgs.push("--voice", `out/${base}-voice.wav`);
if (bgmPath || voiceMade) await run("6/6 合成", "node", ["tools/mix-audio.mjs", ...mixArgs]);
else console.log("=== 6/6 合成：无配音无 BGM，最终产物即渲染文件 ===");

const finalVideo = bgmPath || voiceMade ? finalPath : videoPath;
const s = JSON.parse(readFileSync(scriptPath, "utf8"));
console.log(`
──────── 生产小结 ────────
人物：${s.subject.name}（${s.subject.birth_year} 年生）
模板：${s.template || "classic"}　配音音色：${s.voice?.style || "无"}　BGM 风格：${s.bgm_style || "-"}
事实核查：${s.factcheck ? `${s.factcheck.verdict}（${s.factcheck.by}，问题 ${s.factcheck.issues} 处，详见 src/data/people/${base}.review.md）` : reviewState === "failed" ? "⚠ 审查失败未完成——脚本未经异源核查，发布前请重跑 fact-check" : "未审查（按要求跳过）"}
BGM 状态：${bgm ? `手动指定（${bgm}）` : bgmPick ? `已自动配乐（${bgmPick.file}）` : "未配乐，待补混"}
产物：${finalVideo.replace(ROOT + "/", "")}
日志：${logPath.replace(ROOT + "/", "")}${bgmPath ? "" : "\n（还没配 BGM：曲子下载好后跑下一行补混，不用重渲）"}`);
if (!bgmPath) {
  console.log(`音乐提示词: node tools/music-prompt.mjs ${scriptRel}`);
  console.log(`补混命令:   node tools/mix-audio.mjs out/${base}.mp4 --bgm <曲子文件>${voiceMade ? ` --voice out/${base}-voice.wav` : ""} --out out/${base}-final.mp4`);
}
