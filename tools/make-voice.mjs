#!/usr/bin/env node
/**
 * 头尾配音工具：把「开头介绍 + 结尾升华」两句配音拼成一条与视频等长的音轨。
 *
 * 设计: 中间不配音（保住音乐和画面的节奏），配音只占头尾，所以视频永远不用
 * 等配音——开头从 0 秒起，结尾反向对齐，让最后一句在视频结束前说完。
 *
 * 音色: 一套音色 = tools/voice-profiles.json 里的一项（引擎 + 音色 id + 语气）。
 *   选择顺序: --style > 脚本 voice.style > 配置里的 default。
 *   引擎三种: edge（本机 edge-tts，免费）、gemini（文字描述定制音色与语气，
 *   需 GEMINI_API_KEY）、elevenlabs（音色库/声音克隆，需 ELEVENLABS_API_KEY）。
 *   --tts-cmd '命令 {text} {out}' 可覆盖一切，--intro-file/--outro-file 可喂现成音频。
 *
 * 用法:
 *   node tools/make-voice.mjs src/data/newton.json --video out/newton.mp4
 *   node tools/make-voice.mjs src/data/newton.json --video out/newton.mp4 --style elder
 *   node tools/make-voice.mjs src/data/newton.json --dry-run        只看方案，不生成
 *
 * 文案来源: 脚本 JSON 的 voice.intro / voice.outro，--intro/--outro 可覆盖。
 * 总时长: --total 秒 > --video 探测 > 按脚本 hook_dur + 各段 dur 计算。
 * 然后合成: node tools/mix-audio.mjs 视频.mp4 --bgm 曲.mp3 --voice 配音.wav
 *   (mix-audio 默认开人声压乐: 有人声时音乐自动压低，说完恢复)
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 与 agent 共用仓库根目录的 .env（已在环境变量里的优先，不覆盖）
try {
  for (const line of readFileSync(join(HERE, "..", ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const args = process.argv.slice(2);
const scriptPath = args.find((a) => !a.startsWith("--") && a.endsWith(".json"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const profiles = JSON.parse(readFileSync(join(HERE, "voice-profiles.json"), "utf8"));
let script = null;
let intro = flag("intro", null);
let outro = flag("outro", null);
if (scriptPath) {
  script = JSON.parse(readFileSync(scriptPath, "utf8"));
  intro = intro ?? script.voice?.intro ?? null;
  outro = outro ?? script.voice?.outro ?? null;
}
const styleId =
  flag("style", null) || script?.voice?.style || profiles.default || "yunyang";
const profile = profiles.styles[styleId];
if (!profile) {
  console.error(`音色 ${styleId} 不在 voice-profiles.json 里，可选: ${Object.keys(profiles.styles).join(", ")}`);
  process.exit(1);
}

const introFile = flag("intro-file", null);
const outroFile = flag("outro-file", null);
if (!intro && !introFile && !outro && !outroFile) {
  console.error("没有配音文案：脚本里加 voice.intro / voice.outro，或用 --intro/--outro/--intro-file/--outro-file");
  process.exit(1);
}
const videoPath = flag("video", null);
let total = parseFloat(flag("total", "0"));
if (!total && videoPath)
  total = parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath]).toString().trim()
  );
if (!total && script)
  total = (script.hook_dur || 0) + script.segments.reduce((s, x) => s + x.dur, 0);
const tailPad = parseFloat(flag("tail-pad", "0.3"));
const out = flag("out", "out/voice.wav");
const dryRun = args.includes("--dry-run");

console.log(`音色: ${styleId}（${profile.label}，引擎 ${profile.engine}，音色 id ${profile.voice}）`);
if (dryRun) {
  if (intro) console.log(`开头文案: ${intro}`);
  if (outro) console.log(`结尾文案: ${outro}`);
  console.log(`总时长: ${total ? total.toFixed(1) + "s" : "未知（给 --video 或 --total）"}，输出: ${out}`);
  process.exit(0);
}
if (!total) {
  console.error("不知道视频总时长：给 --total 秒 或 --video 视频.mp4");
  process.exit(1);
}

function probeDur(f) {
  return parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()
  );
}

const tmp = mkdtempSync(join(tmpdir(), "lk-voice-"));
async function synth(text, name) {
  const dest = join(tmp, name);
  const tpl = flag("tts-cmd", null);
  if (tpl) {
    execSync(tpl.replaceAll("{text}", text.replaceAll('"', "'")).replaceAll("{out}", dest), { stdio: "inherit" });
  } else if (profile.engine === "edge") {
    const voiceName = flag("voice-name", profile.voice);
    const rate = flag("rate", profile.rate || "+0%");
    execFileSync("edge-tts", ["--voice", voiceName, "--rate", rate, "--text", text, "--write-media", dest], {
      stdio: "inherit",
    });
  } else if (profile.engine === "gemini") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("gemini 引擎需要环境变量 GEMINI_API_KEY");
    const prompt = profile.style ? `${profile.style}\n\n朗读以下文字：\n${text}` : text;
    const res = await fetch(
      // TTS 模型可由 GEMINI_TTS_MODEL 覆盖；默认 3.8-flash-tts（2.5-flash-preview-tts 已对新用户下线，2026-10-26 实测名单）
      `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts"}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: profile.voice } } },
          },
        }),
      }
    );
    const j = await res.json();
    if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
    const b64 = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!b64) throw new Error("Gemini TTS 响应里没有音频");
    const pcm = dest + ".pcm";
    writeFileSync(pcm, Buffer.from(b64, "base64"));
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm, dest]);
  } else if (profile.engine === "elevenlabs") {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("elevenlabs 引擎需要环境变量 ELEVENLABS_API_KEY");
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(profile.voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": key },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
      }
    );
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 400)}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  } else {
    throw new Error(`未知引擎: ${profile.engine}`);
  }
  if (!existsSync(dest)) throw new Error("TTS 没产出文件: " + dest);
  return dest;
}

const parts = [];
if (intro || introFile) {
  const f = introFile || (await synth(intro, "intro.mp3"));
  parts.push({ f, at: 0, dur: probeDur(f), name: "开头" });
}
if (outro || outroFile) {
  const f = outroFile || (await synth(outro, "outro.mp3"));
  const d = probeDur(f);
  parts.push({ f, at: Math.max(0, total - d - tailPad), dur: d, name: "结尾" });
}
if (parts.length === 2 && parts[1].at < parts[0].at + parts[0].dur + 1)
  console.error(`警告: 结尾配音起点 ${parts[1].at.toFixed(1)}s 与开头配音太近，可能重叠`);

const ff = ["-y"];
for (const p of parts) ff.push("-i", p.f);
ff.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
const chains = parts.map((p, i) => {
  const delay = p.at > 0 ? `,adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}` : "";
  return `[${i}:a]aresample=44100,aformat=channel_layouts=stereo${delay}[p${i}]`;
});
const labels = parts.map((_, i) => `[p${i}]`).join("");
const base = parts.length;
chains.push(
  `[${base}:a]atrim=end=${total.toFixed(3)}[base]`,
  `[base]${labels}amix=inputs=${parts.length + 1}:duration=first:normalize=0[voiceout]`
);
ff.push("-filter_complex", chains.join(";"), "-map", "[voiceout]", "-t", total.toFixed(3), out);
execFileSync("ffmpeg", ff, { stdio: "pipe" });
for (const p of parts)
  console.log(`${p.name}配音: ${p.at.toFixed(1)}s 起, 长 ${p.dur.toFixed(1)}s`);
console.log("已生成配音轨:", out, `(全长 ${total.toFixed(1)}s)`);
console.log(`合成: node tools/mix-audio.mjs ${videoPath || "视频.mp4"} --bgm 曲.mp3 --voice ${out}`);
