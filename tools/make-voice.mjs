#!/usr/bin/env node
/**
 * 头尾配音工具：把「开头介绍 + 结尾升华」两句配音拼成一条与视频等长的音轨。
 *
 * 设计: 中间不配音（保住音乐和画面的节奏），配音只占头尾，所以视频永远不用
 * 等配音——开头从 0 秒起，结尾反向对齐，让最后一句在视频结束前说完。
 *
 * 用法:
 *   node tools/make-voice.mjs src/data/newton.json --video out/newton.mp4
 *   node tools/make-voice.mjs --intro "这是牛顿的一生" --outro "……" --total 65.7
 *
 * 文案来源: 脚本 JSON 的 voice.intro / voice.outro，--intro/--outro 可覆盖。
 * 总时长: --total 秒 > --video 探测 > 按脚本 hook_dur + 各段 dur 计算。
 * TTS: 默认 edge-tts（本机 pip install edge-tts），音色 --voice-name 指定。
 *   --intro-file/--outro-file 给现成音频可跳过 TTS（任何 TTS 服务或真人录音都行）。
 *   --tts-cmd '命令 {text} {out}' 可换任意 TTS 命令行。
 * 然后合成: node tools/mix-audio.mjs 视频.mp4 --bgm 曲.mp3 --voice 配音.wav
 *   (mix-audio 默认开人声压乐: 有人声时音乐自动压低，说完恢复)
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const scriptPath = args.find((a) => !a.startsWith("--") && a.endsWith(".json"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
let intro = flag("intro", null);
let outro = flag("outro", null);
let script = null;
if (scriptPath) {
  script = JSON.parse(readFileSync(scriptPath, "utf8"));
  intro = intro ?? script.voice?.intro ?? null;
  outro = outro ?? script.voice?.outro ?? null;
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
if (!total) {
  console.error("不知道视频总时长：给 --total 秒 或 --video 视频.mp4");
  process.exit(1);
}
const tailPad = parseFloat(flag("tail-pad", "0.3"));
const out = flag("out", "out/voice.wav");
const tmp = mkdtempSync(join(tmpdir(), "lk-voice-"));

function probeDur(f) {
  return parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()
  );
}
function synth(text, name) {
  const dest = join(tmp, name);
  const tpl = flag("tts-cmd", null);
  if (tpl) {
    execSync(tpl.replaceAll("{text}", text.replaceAll('"', "'")).replaceAll("{out}", dest), { stdio: "inherit" });
  } else {
    const voiceName = flag("voice-name", "zh-CN-YunyangNeural");
    const rate = flag("rate", "+0%");
    execFileSync("edge-tts", ["--voice", voiceName, "--rate", rate, "--text", text, "--write-media", dest], {
      stdio: "inherit",
    });
  }
  if (!existsSync(dest)) throw new Error("TTS 没产出文件: " + dest);
  return dest;
}

const parts = [];
if (intro || introFile) {
  const f = introFile || synth(intro, "intro.mp3");
  parts.push({ f, at: 0, dur: probeDur(f), name: "开头" });
}
if (outro || outroFile) {
  const f = outroFile || synth(outro, "outro.mp3");
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
