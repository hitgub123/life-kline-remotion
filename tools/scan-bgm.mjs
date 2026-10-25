#!/usr/bin/env node
/**
 * 曲库扫描登记：在本机测量 assets/bgm/ 里每首曲子的时长、BPM、高潮位置，
 * 写进同目录的 manifest.json（文本台账，进 git）。音频本体不入 git，
 * 远端（Muse / 其他协作者）看 manifest 就能知道曲库全貌与每首的数据。
 *
 * 用法: node tools/scan-bgm.mjs
 * 依赖: ffmpeg / ffprobe（混音本来就用）。
 * 测得准的：时长、高潮点（0.5 秒窗 RMS 能量峰值）；BPM 是起始脉冲自相关
 * 估算，个别曲子可能差倍频，manifest 里人工可改。
 * 测不了的：有没有人声、好不好听——那一关靠耳朵。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
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

const BGM_DIR = join(ROOT, "assets", "bgm");
const MANIFEST = join(BGM_DIR, "manifest.json");

let styleIds = [];
try {
  const cat = JSON.parse(readFileSync(join(ROOT, "tools", "bgm-styles.json"), "utf8"));
  styleIds = Object.keys(cat.styles || {}).filter((k) => k !== "default");
} catch {}

function probeDuration(file) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" }
    );
    const d = parseFloat(out.trim());
    if (d > 0) return d;
  } catch {}
  try {
    const r = spawnSync("ffmpeg", ["-i", file], { encoding: "utf8" });
    const m = (r.stderr || "").match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
  } catch {}
  return null;
}

function analyze(file) {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
    { maxBuffer: 512 * 1024 * 1024 }
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 8000) return null;
  const buf = r.stdout;
  const n = Math.floor(buf.length / 4);
  const sr = 8000;
  const sample = (i) => buf.readFloatLE(i * 4);
  // 高潮点：0.5 秒窗 RMS 能量峰值（避开首尾各 1 秒）
  const win = Math.floor(sr * 0.5);
  const wins = Math.floor(n / win);
  let peak = -1;
  let peakVal = -1;
  for (let w = 0; w < wins; w++) {
    let s = 0;
    for (let i = 0; i < win; i++) {
      const v = sample(w * win + i);
      s += v * v;
    }
    const rms = Math.sqrt(s / win);
    if (w >= 2 && w < wins - 2 && rms > peakVal) {
      peakVal = rms;
      peak = w;
    }
  }
  const climaxAt = peak >= 0 ? Math.round((peak * 0.5 + 0.25) * 10) / 10 : null;
  // BPM：10ms 跳的能量起始脉冲自相关（33–100 帧 ≈ 60–180 BPM，项数归一化）
  const hop = Math.floor(sr * 0.01);
  const frames = Math.floor(n / hop);
  const onset = new Float32Array(frames);
  let prevE = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const st = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = sample(st + i);
      s += v * v;
    }
    onset[f] = Math.max(0, s - prevE);
    prevE = s;
  }
  let bestLag = 0;
  let bestVal = -1;
  const scores = [];
  for (let lag = 33; lag <= 100; lag++) {
    let s = 0;
    for (let f = 0; f + lag < frames; f++) s += onset[f] * onset[f + lag];
    s /= frames - lag;
    scores.push([lag, s]);
    if (s > bestVal) {
      bestVal = s;
      bestLag = lag;
    }
  }
  // 防倍频误读：取「分数不低于最佳 85%」里最长的周期（基频优先于二倍频）
  for (const [lag, s] of scores) if (s >= bestVal * 0.85 && lag > bestLag) bestLag = lag;
  let bpm = bestLag ? 6000 / bestLag : null;
  if (bpm) {
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    bpm = Math.round(bpm * 10) / 10;
  }
  return { climaxAt, bpm };
}

if (!existsSync(BGM_DIR)) {
  console.error("没有 assets/bgm/ 目录。");
  process.exit(1);
}
const files = readdirSync(BGM_DIR)
  .filter((f) => /\.(mp3|wav|m4a)$/i.test(f))
  .sort();
if (!files.length) {
  console.log("assets/bgm/ 里还没有音频文件。");
  process.exit(0);
}
let manifest = { _说明: "曲库登记表（node tools/scan-bgm.mjs 维护测量字段）。", tracks: [] };
if (existsSync(MANIFEST)) {
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {}
}
if (!Array.isArray(manifest.tracks)) manifest.tracks = [];
const byFile = new Map(manifest.tracks.map((t) => [t.file, t]));

console.log(`曲库扫描（${files.length} 首）：`);
for (const f of files) {
  const path = join(BGM_DIR, f);
  const dur = probeDuration(path);
  const ana = analyze(path);
  const prev = byFile.get(f) || {};
  const styleHit = styleIds.find((id) => f.startsWith(id + "-")) || null;
  const entry = {
    file: f,
    styles: prev.styles && prev.styles.length ? prev.styles : styleHit ? [styleHit] : [],
    bpm: ana && ana.bpm ? ana.bpm : prev.bpm ?? null,
    mood: prev.mood || "",
    auto: prev.auto ?? false,
    duration: dur ? Math.round(dur * 10) / 10 : prev.duration ?? null,
    climaxAt: ana && ana.climaxAt != null ? ana.climaxAt : prev.climaxAt ?? null,
    note: prev.note || "",
  };
  byFile.set(f, entry);
  const climaxFlag =
    entry.climaxAt != null ? (entry.climaxAt >= 28 && entry.climaxAt <= 45 ? "✓" : "⚠ 高潮不在 28–45 秒") : "";
  console.log(
    `- ${f}：时长 ${entry.duration ?? "?"}s，BPM ${entry.bpm ?? "?"}，高潮 ${entry.climaxAt ?? "?"}s ${climaxFlag}，风格 ${entry.styles.join("/") || "未标"}`
  );
}
manifest.tracks = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n已写入 assets/bgm/manifest.json（${manifest.tracks.length} 条）。把这个文件 commit 上去，远端就能看到曲库全貌。`);
