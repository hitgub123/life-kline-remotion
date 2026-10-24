#!/usr/bin/env node
/**
 * 后期合成工具：把 BGM 和/或配音灌回已渲染的视频，视频流不重编码。
 *
 * 用法:
 *   node tools/mix-audio.mjs out/newton.mp4 --bgm ~/音乐/曲库/xxx.mp3
 *   node tools/mix-audio.mjs out/newton.mp4 --bgm xxx.mp3 --voice 配音.wav
 *   node tools/mix-audio.mjs out/newton.mp4 --voice 配音.wav --out 成片.mp4
 *
 * 选项:
 *   --bgm-volume  BGM 音量，默认 0.15（有配音时是垫底音量；只有 BGM 时建议 0.5-0.8）
 *   --voice-volume 配音音量，默认 1
 *   --out         输出文件，默认在视频名后加 -mixed
 *
 * 行为: BGM 自动循环铺满全片，结尾 2 秒淡出；配音按整条音轨贴入（分段配音请先
 * 按段起始时间拼成整条再喂进来）。BGM 曲库建议放在仓库外，路径随便给。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith("--"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const bgm = flag("bgm", null);
const voice = flag("voice", null);
const bgmVol = parseFloat(flag("bgm-volume", voice ? "0.15" : "0.6"));
const voiceVol = parseFloat(flag("voice-volume", "1"));
const out = flag("out", null) || (video ? video.replace(/\.mp4$/i, "") + "-mixed.mp4" : null);

if (!video || (!bgm && !voice)) {
  console.error("用法: node tools/mix-audio.mjs 视频.mp4 --bgm 音乐.mp3 [--voice 配音.wav] [--bgm-volume 0.15] [--out 输出.mp4]");
  process.exit(1);
}
for (const f of [video, bgm, voice].filter(Boolean))
  if (!existsSync(f)) {
    console.error("文件不存在:", f);
    process.exit(1);
  }

const dur = parseFloat(
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video])
    .toString()
    .trim()
);

const ff = ["-y", "-i", video];
if (bgm) ff.push("-stream_loop", "-1", "-i", bgm);
if (voice) ff.push("-i", voice);

const filters = [];
let bgmLabel = null;
let voiceLabel = null;
if (bgm) {
  const idx = 1;
  filters.push(
    `[${idx}:a]atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB,volume=${bgmVol},afade=t=out:st=${Math.max(0, dur - 2).toFixed(3)}:d=2[bgm]`
  );
  bgmLabel = "[bgm]";
}
if (voice) {
  const idx = bgm ? 2 : 1;
  filters.push(`[${idx}:a]volume=${voiceVol},apad[voice]`);
  voiceLabel = "[voice]";
}
let aout;
if (bgmLabel && voiceLabel) {
  filters.push(`[voice][bgm]amix=inputs=2:duration=first:normalize=0[aout]`);
  aout = "[aout]";
} else {
  aout = bgmLabel || voiceLabel;
}

ff.push(
  "-filter_complex", filters.join(";"),
  "-map", "0:v", "-map", aout,
  "-c:v", "copy", "-c:a", "aac", "-shortest", out
);
console.log("ffmpeg", ff.join(" "));
execFileSync("ffmpeg", ff, { stdio: "inherit" });
console.log("已合成:", out);
