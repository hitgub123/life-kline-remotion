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
 *   --bgm-volume  BGM 音量，默认 0.6（有配音时是无人声段落的音量）
 *   --voice-volume 配音音量，默认 1
 *   --no-duck     关掉人声压乐。默认开启：有人声时 BGM 被自动压低（实测约 15-20dB），
 *                 说完自动恢复，中间纯音乐段落保持原音量。关掉则 BGM 全程
 *                 --bgm-volume*0.25 的垫底音量
 *   --bgm-offset  BGM 时间偏移秒数，可负。生成音乐的第一拍常不在 0 秒，
 *                 用它把第一拍平移到视频 0 秒，拍点才能和蜡烛网格对齐
 *   --voice-offset 配音时间偏移秒数，可负，默认 0
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
const noDuck = args.includes("--no-duck");
const bgmVol = parseFloat(flag("bgm-volume", voice && noDuck ? "0.15" : "0.6"));
const voiceVol = parseFloat(flag("voice-volume", "1"));
const bgmOffset = parseFloat(flag("bgm-offset", "0"));
const voiceOffset = parseFloat(flag("voice-offset", "0"));
const out = flag("out", null) || (video ? video.replace(/\.mp4$/i, "") + "-mixed.mp4" : null);

if (!video || (!bgm && !voice)) {
  console.error("用法: node tools/mix-audio.mjs 视频.mp4 --bgm 音乐.mp3 [--voice 配音.wav] [--bgm-volume 0.15] [--out 输出.mp4]");
  process.exit(1);
}
for (const f of [video, bgm, voice].filter(Boolean))
  if (!existsSync(f)) {
    console.error("文件不存在:", f);
    console.error("（路径含空格或括号时，命令行里要用引号把整个路径括起来，如 --bgm \"折線 (Version 2).mp3\"；长远看文件名别用空格，见 docs/BGM-LIBRARY.md）");
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

// 把偏移拆成裁剪（负偏移）和延迟（正偏移）两段滤镜
function offsetFilters(offset) {
  const trim = offset < 0 ? `atrim=start=${(-offset).toFixed(3)},` : "";
  const delay =
    offset > 0 ? `adelay=${Math.round(offset * 1000)}|${Math.round(offset * 1000)},` : "";
  return { trim, delay };
}

const filters = [];
const duck = bgm && voice && !noDuck;
let bgmLabel = null;
let voiceLabel = null;
if (bgm) {
  const idx = 1;
  const { delay } = offsetFilters(bgmOffset);
  const start = bgmOffset < 0 ? -bgmOffset : 0;
  const lbl = duck ? "bgmraw" : "bgm";
  filters.push(
    `[${idx}:a]atrim=start=${start.toFixed(3)}:end=${(start + dur).toFixed(3)},asetpts=N/SR/TB,${delay}aresample=44100,volume=${bgmVol},afade=t=out:st=${Math.max(0, dur - 2).toFixed(3)}:d=2[${lbl}]`
  );
  bgmLabel = `[${lbl}]`;
}
if (voice) {
  const idx = bgm ? 2 : 1;
  const { trim, delay } = offsetFilters(voiceOffset);
  if (duck) {
    filters.push(
      `[${idx}:a]${trim}asetpts=N/SR/TB,${delay}aresample=44100,aformat=channel_layouts=stereo,volume=${voiceVol},apad,asplit=2[vkey][voice]`
    );
  } else {
    filters.push(`[${idx}:a]${trim}asetpts=N/SR/TB,${delay}volume=${voiceVol},apad[voice]`);
  }
  voiceLabel = "[voice]";
}
if (duck) {
  filters.push(
    // release 500→1200：释放太短时，结尾旁白的句间停顿里 BGM 会反复涌回满音量再被压下，
    // 听感像音乐和人声在「交替出现」（2026-10-26 马云成片反馈）；拉长释放后停顿内只缓慢回升。
    `[bgmraw][vkey]sidechaincompress=threshold=0.02:ratio=9:attack=40:release=1200:makeup=1[bgm]`
  );
  bgmLabel = "[bgm]";
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
