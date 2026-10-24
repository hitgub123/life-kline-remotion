#!/usr/bin/env node
/**
 * 音乐提示词生成工具：读人物脚本，算出段界时间和关键时刻，生成一份可直接
 * 粘进 Google Flow Music 的提示词，让音乐的 BPM 和段落转折与视频卡点。
 *
 * 用法:
 *   node tools/music-prompt.mjs src/data/newton.json
 *   node tools/music-prompt.mjs src/data/newton.json --mode vocal --voice "a warm husky female alto"
 *
 * 原理: 视频的蜡烛出现在半拍网格上（脚本 bpm，缺省 120），段界都在网格点上。
 * 提示词里写死同一个 BPM，并用时间标记让音乐在巅峰段开始时推到高潮、
 * 谷底段转安静、退市印章落下时收住、结尾段重新扬起。
 * 生成后把曲子下载下来，用 mix-audio 合成；若第一拍不在 0 秒，
 * 用 --bgm-offset 把第一拍平移到 0 秒即可全程对齐。
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const mode = flag("mode", "instrumental");
const promptOnly = args.includes("--prompt-only");
const voiceDesc = flag("voice", "a warm, slightly husky female alto voice");
if (!file) {
  console.error("用法: node tools/music-prompt.mjs src/data/xxx.json [--mode instrumental|vocal] [--voice 声线描述]");
  process.exit(1);
}
const d = JSON.parse(readFileSync(file, "utf8"));
const bpm = d.bpm ?? 120;
const beat = 60 / bpm;

// 段界时间
const starts = [];
let t = d.hook_dur;
for (const s of d.segments) {
  starts.push(t);
  t += s.dur;
}
const total = t;

// 关键时刻
const kp = d.keypoints;
const maxKi = kp.reduce((bi, k, i) => (k[1] > kp[bi][1] ? i : bi), 0);
// 谷底取「巅峰之后」的最低点，才是人生中段的崩落；开局低点不算
const afterPeak = kp.map((k, i) => [k[1], i]).filter(([, i]) => i > maxKi);
const minKi = afterPeak.length
  ? afterPeak.reduce((b, x) => (x[0] < b[0] ? x : b))[1]
  : -1;
const segStartOfKp = (ki) => {
  const si = d.segments.findIndex((s) => s.kp[0] <= ki && ki <= s.kp[1] && !(s.kp[0] === s.kp[1] && ki !== s.kp[0]));
  return si >= 0 ? starts[si] : null;
};
const peakAt = segStartOfKp(maxKi);
const valleyAt = segStartOfKp(minKi);
const stampSeg = d.segments.findIndex((s) => s.stamp);
const stampAt = stampSeg >= 0 ? starts[stampSeg] + d.segments[stampSeg].dur : null;
const rocketSeg = d.segments.findIndex((s) => s.rocket);
const rocketAt = rocketSeg >= 0 ? starts[rocketSeg] : null;

const f1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
if (!promptOnly) {
  console.log(`# ${d.subject.name} · 音乐卡点表（BPM ${bpm}，一拍 ${beat.toFixed(2)} 秒）\n`);
  console.log("| 时间 | 拍号 | 事件 |");
  console.log("|---|---|---|");
  d.segments.forEach((s, i) => {
    const marks = [];
    if (i === 0) marks.push("正片开始");
    if (peakAt === starts[i]) marks.push("全片巅峰段");
    if (valleyAt === starts[i]) marks.push("谷底段");
    if (s.stamp) marks.push("退市印章在本段末");
    if (s.rocket) marks.push("结尾冲顶段");
    console.log(`| ${f1(starts[i])}s | 第 ${Math.round(starts[i] / beat)} 拍 | ${s.id} ${marks.join("、")} |`);
  });
  console.log(`| ${f1(total)}s | 第 ${Math.round(total / beat)} 拍 | 结束 |\n`);
}

const structure = [
  `quiet, hopeful opening from 0s`,
  peakAt != null ? `build up and reach the biggest emotional climax at ${f1(peakAt)}s` : null,
  valleyAt != null && valleyAt !== peakAt ? `drop to a quiet, fragile breakdown at ${f1(valleyAt)}s` : null,
  rocketAt != null ? `a brief hush just before ${f1(rocketAt)}s, then a final uplifting lift from ${f1(rocketAt)}s to the end` : null,
]
  .filter(Boolean)
  .join("; ");

const tags = typeof d.bgm_tags === "string" && d.bgm_tags.trim() ? d.bgm_tags.trim() : null;
const head =
  mode === "vocal"
    ? `A Mandarin emotional ballad sung by ${voiceDesc}, with piano and strings. Lyrics about a life that rises and falls like a stock chart: glory, downfall, and dignity at the end.${tags ? ` Style direction: ${tags}.` : ""}`
    : `Instrumental only, no vocals. ${tags ? tags + "." : "A cinematic piano and strings piece about the rises and falls of a great life."}`;

const PROMPT_TEXT = `${head} Exactly ${bpm} BPM with a strict steady tempo, a strong downbeat right at the very start, no fade-in intro. Structure with timing: ${structure}. The core material should cover about ${Math.round(total)} seconds (a longer track is fine, it will be trimmed). End cleanly on the beat.`;
if (promptOnly) {
  console.log(PROMPT_TEXT);
  process.exit(0);
}
console.log("## 粘进 Flow Music 的提示词\n");
console.log(PROMPT_TEXT);
const fileBase = file.split("/").pop().replace(/\.json$/, "");
console.log(`
## 生成后合成（第一拍不在 0 秒时才需要 offset，数值=第一拍出现的秒数取负）

node tools/mix-audio.mjs out/${fileBase}.mp4 --bgm 曲库/下载的曲子.mp3 --bgm-offset 0
`);
