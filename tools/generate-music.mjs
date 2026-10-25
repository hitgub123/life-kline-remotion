#!/usr/bin/env node
/**
 * 音乐生成工具：调 Gemini API 的 Lyria 3.5 生成整首歌，落盘到 assets/bgm/。
 * 这就是 Flow Music 背后的同一个模型，只是走 API，不用开网页。
 *
 * 用法:
 *   GEMINI_API_KEY=xxx node tools/generate-music.mjs --script src/data/newton.json
 *   GEMINI_API_KEY=xxx node tools/generate-music.mjs --script src/data/newton.json --mode vocal --takes 3
 *   GEMINI_API_KEY=xxx node tools/generate-music.mjs --prompt "一段提示词" --out assets/bgm/x.mp3
 *   node tools/generate-music.mjs --script src/data/newton.json --dry-run   只看请求，不调 API
 *   node tools/generate-music.mjs --from-file 响应.json --out assets/bgm/x.mp3  导入已有响应（测试用）
 *
 * 费用: Lyria 3.5 按首计费，约 $0.08/首，没有免费层，失败也计费（Google 定价页口径）。
 * key 必须来自开了付费的 Google Cloud 项目；AI Pro 订阅的额度不能抵 API 费用，两套账。
 * 生成是单轮的，没有网页版那种「只改副歌」的迭代编辑，不满意就换提示词重生一首。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 与 agent 共用仓库根目录的 .env（已在环境变量里的优先，不覆盖）
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const MODEL = "lyria-3.5";

const args = process.argv.slice(2);
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const scriptPath = flag("script", null);
const mode = flag("mode", "instrumental");
const voice = flag("voice", null);
const takes = Math.max(1, parseInt(flag("takes", "1"), 10) || 1);
const wav = args.includes("--wav");
const dryRun = args.includes("--dry-run");
const fromFile = flag("from-file", null);
let outPath = flag("out", null);
let prompt = flag("prompt", null);

if (scriptPath && !prompt) {
  const mpArgs = [join(ROOT, "tools/music-prompt.mjs"), scriptPath, "--mode", mode, "--prompt-only"];
  if (voice) mpArgs.push("--voice", voice);
  prompt = execFileSync("node", mpArgs).toString().trim();
  if (!outPath) {
    const base = scriptPath.split("/").pop().replace(/\.json$/, "");
    outPath = join("assets/bgm", `${base}-theme.${wav ? "wav" : "mp3"}`);
  }
}
if (!prompt && !fromFile) {
  console.error("用法: node tools/generate-music.mjs --script src/data/xxx.json [--mode vocal] [--takes N] [--wav] [--out 路径]");
  console.error("或:   node tools/generate-music.mjs --prompt \"提示词\" --out assets/bgm/x.mp3");
  process.exit(1);
}
if (!outPath) outPath = "assets/bgm/track.mp3";

function buildBody() {
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (wav) {
    body.generationConfig = {
      responseModalities: ["AUDIO", "TEXT"],
      responseFormat: { audio: { mimeType: "AUDIO_WAV" } },
    };
  }
  return body;
}

async function callLyria() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("缺环境变量 GEMINI_API_KEY");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(buildBody()),
      }
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`Lyria API ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function saveResponse(j, dest) {
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const audio = parts.find((p) => p.inlineData && /^audio\//.test(p.inlineData.mimeType || ""));
  if (!audio) {
    writeFileSync(join(ROOT, "tools/last-music-response.json"), JSON.stringify(j, null, 2));
    throw new Error("响应里没有音频，原始响应已存 tools/last-music-response.json");
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(audio.inlineData.data, "base64"));
  const lyrics = parts.filter((p) => p.text).map((p) => p.text).join("\n").trim();
  if (lyrics) writeFileSync(dest.replace(/\.(mp3|wav)$/i, "") + ".lyrics.txt", lyrics + "\n");
  return dest;
}

if (dryRun) {
  console.log(JSON.stringify({ model: MODEL, out: outPath, takes, body: buildBody() }, null, 2));
  process.exit(0);
}

if (fromFile) {
  const j = JSON.parse(readFileSync(fromFile, "utf8"));
  console.log("已导入:", saveResponse(j, outPath));
  process.exit(0);
}

for (let k = 1; k <= takes; k++) {
  const dest =
    takes > 1 ? outPath.replace(/(\.[^.]+)$/, `-take${k}$1`) : outPath;
  if (existsSync(dest)) {
    console.error(`${dest} 已存在，换 --out 或先删掉`);
    process.exit(1);
  }
  console.log(`生成中（第 ${k}/${takes} 首，约 $0.08）...`);
  const j = await callLyria();
  console.log("已保存:", saveResponse(j, dest));
}
console.log(`
下一步（合成到视频，第一拍偏移按需调整）:
  node tools/mix-audio.mjs out/<视频>.mp4 --bgm ${outPath} --bgm-offset 0
`);
