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
 *   node tools/produce.mjs "马斯克" --id ElonMusk --langs ja,en   # 中文跑完后顺带出日/英版
 *   node tools/produce.mjs "马斯克" --id ElonMusk --langs ja,en --dry-run  # 只打印计划不真跑
 *
 * --langs 多语言：中文主流程完成后，对每个附加语言依次 翻译→渲染→配音→合成，
 * 产出 out/<id>-<lang>-final.mp4（沿用中文版同一首已定 BGM）。每语言独立断点续跑、
 * 独立成败：某语言失败只跳过它，不拖垮其他语言与中文成品；配音失败时宁可跳过
 * 该语言也绝不静默产出无声片。默认不带 --langs 时行为与以前完全一致（仅中文）。
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
const dryRun = args.includes("--dry-run");
// 多语言版（--langs ja,en）：语言元数据与 translate-script 的口径保持一致
const LANG_META = {
  ja: { suffix: "Ja", label: "日语", voice: "nanami" },
  en: { suffix: "En", label: "英语", voice: "aria" },
};
const langs = flag("langs", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const l of langs) {
  if (!LANG_META[l]) {
    console.error(`--langs 不支持的语言：${l}（只支持 ${Object.keys(LANG_META).join("/")}）`);
    process.exit(1);
  }
}
if (!name || !id || !/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
  console.error('用法: node tools/produce.mjs "人名" --id EnglishId [--bgm 曲.mp3] [--provider gemini] [--skip-review] [--force] [--langs ja,en] [--dry-run]');
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

// 从 registry 反查某份脚本（如 elonmusk.ja）注册的 Composition id
function compIdFor(baseFile) {
  try {
    const reg = readFileSync(join(ROOT, "src/data/registry.ts"), "utf8");
    const imp = reg.match(new RegExp(`import ([A-Za-z0-9]+) from "\\./${baseFile.replace(/\./g, "\\.")}\\.json";`));
    if (imp) {
      const entry = reg.match(new RegExp(`\\{ id: "([A-Za-z0-9]+)", data: ${imp[1]} as unknown as ScriptData \\}`));
      if (entry) return entry[1];
    }
  } catch {}
  return null;
}

// --dry-run：只打印中文主流程 + 各语言将执行的步骤计划，不真跑（无 API/无音频环境验线用）
if (dryRun) {
  const plan = (cond) => (cond ? "跳过（已完成/最新）" : "执行");
  console.log(`[dry-run] ${name}（${id}）生产计划，不执行任何步骤：`);
  console.log(`  中文 1/6 取材：${plan(existsSync(join(ROOT, "src/data/people", base + ".md")) && !force)} → src/data/people/${base}.md`);
  console.log(`  中文 2/6 生成：${plan(existsSync(scriptPath) && !force)} → ${scriptRel}`);
  console.log(`  中文 3/6 事实核查：${skipReview ? "跳过（--skip-review）" : "执行（失败不拦生产）"}`);
  console.log(`  中文 4/6 渲染：${plan(existsSync(videoPath) && !force)} → out/${base}.mp4（Composition ${id}）`);
  console.log(`  中文 5/6 配音：${skipVoice ? "跳过（--skip-voice）" : plan(existsSync(voicePath) && !force)} → out/${base}-voice.wav`);
  console.log(`  中文 6/6 合成：${bgm ? `手动 BGM ${bgm}` : "自动选曲（与语言版共用同一首）"} → out/${base}-final.mp4`);
  for (const lang of langs) {
    const meta = LANG_META[lang];
    const lScriptPath = join(ROOT, "src/data", `${base}.${lang}.json`);
    const compId = compIdFor(`${base}.${lang}`) || id + meta.suffix;
    console.log(`  ${meta.label}版（${lang}）：`);
    console.log(`    翻译：${plan(existsSync(lScriptPath) && !force)} tools/translate-script.mjs ${scriptRel} --to ${lang} → src/data/${base}.${lang}.json`);
    console.log(`    渲染：Composition ${compId} → out/${base}-${lang}.mp4`);
    console.log(`    配音：音色 ${meta.voice} → out/${base}-${lang}-voice.wav（失败则跳过该语言，不出无声片）`);
    console.log(`    合成：沿用中文版同一首 BGM → out/${base}-${lang}-final.mp4`);
  }
  process.exit(0);
}

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

// ── 多语言版（--langs）：中文成品之后逐语言跑 翻译→渲染→配音→合成 ──
// 每语言独立断点续跑、独立成败；配音失败宁可跳过该语言，绝不静默出无声片。
async function produceLang(lang) {
  const meta = LANG_META[lang];
  const tag = `${meta.label}版`;
  const lScriptRel = `src/data/${base}.${lang}.json`;
  const lScriptPath = join(ROOT, lScriptRel);
  const lVideoPath = join(ROOT, "out", `${base}-${lang}.mp4`);
  const lVoicePath = join(ROOT, "out", `${base}-${lang}-voice.wav`);
  const lFinalPath = join(ROOT, "out", `${base}-${lang}-final.mp4`);
  // 1 翻译（复用 translate-script：只翻文字层、注册 Composition、按语言换音色）
  if (!existsSync(lScriptPath) || force)
    await run(`多语言·${tag} 1/4 翻译脚本`, "node", ["tools/translate-script.mjs", scriptRel, "--to", lang]);
  else console.log(`=== 多语言·${tag} 1/4 翻译：脚本已存在，跳过 ===`);
  const compId = compIdFor(`${base}.${lang}`) || id + meta.suffix;
  // 2 渲染
  const lStale = existsSync(lVideoPath) && existsSync(lScriptPath) && statSync(lVideoPath).mtimeMs < statSync(lScriptPath).mtimeMs;
  if (!existsSync(lVideoPath) || force || lStale)
    await run(`多语言·${tag} 2/4 渲染（${compId}）`, "npx", ["remotion", "render", compId, `out/${base}-${lang}.mp4`], { shell: process.platform === "win32" });
  else console.log(`=== 多语言·${tag} 2/4 渲染：成片已是最新，跳过 ===`);
  // 3 配音（音色由译本脚本 voice.style 决定：ja=nanami / en=aria）
  let lVoiceMade = existsSync(lVoicePath) && !force;
  if (!skipVoice && !lVoiceMade)
    lVoiceMade = await tryRun(`多语言·${tag} 3/4 配音（${meta.voice}）`, "node", [
      "tools/make-voice.mjs", lScriptRel, "--video", `out/${base}-${lang}.mp4`, "--out", `out/${base}-${lang}-voice.wav`,
    ]);
  if (skipVoice) console.log(`=== 多语言·${tag} 3/4 配音：按要求跳过 ===`);
  if (!skipVoice && !lVoiceMade)
    return `${tag}：⚠ 已跳过——配音失败（引擎不可达或合成出错），不产出无声片；修好后重跑 produce --langs ${lang} 即可单独补这一版`;
  // 4 合成（沿用中文版同一首已定 BGM 与同一偏移）
  const lMixArgs = [`out/${base}-${lang}.mp4`, "--out", `out/${base}-${lang}-final.mp4`];
  if (bgmPath) {
    lMixArgs.push("--bgm", bgmPath);
    if (bgmOffset) lMixArgs.push("--bgm-offset", bgmOffset);
  }
  if (lVoiceMade) lMixArgs.push("--voice", `out/${base}-${lang}-voice.wav`);
  let lFinal = lVideoPath;
  if (bgmPath || lVoiceMade) {
    const fresh =
      existsSync(lFinalPath) &&
      !force &&
      statSync(lFinalPath).mtimeMs >= statSync(lVideoPath).mtimeMs &&
      (!lVoiceMade || statSync(lFinalPath).mtimeMs >= statSync(lVoicePath).mtimeMs);
    if (!fresh) await run(`多语言·${tag} 4/4 合成`, "node", ["tools/mix-audio.mjs", ...lMixArgs]);
    else console.log(`=== 多语言·${tag} 4/4 合成：成品已是最新，跳过 ===`);
    lFinal = lFinalPath;
  }
  return `${tag}：✓ ${lFinal.replace(ROOT + "/", "")}`;
}
if (langs.length) {
  console.log(`\n──────── 多语言小结 ────────`);
  for (const lang of langs) {
    try {
      console.log(await produceLang(lang));
    } catch (e) {
      console.log(`${LANG_META[lang].label}版：✗ 失败（${String(e.message || e).split("\n")[0].slice(0, 140)}），不影响其他语言与中文成品`);
    }
  }
}
