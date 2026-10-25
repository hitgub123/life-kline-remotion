#!/usr/bin/env node
/**
 * 配音试音：把音色库里每把嗓子用同一段标准台词各录一遍，放在 out/auditions/，
 * 听完选角。和曲库一个思路——先建试音库，再定常用阵容。
 *
 * 用法: node tools/audition-voice.mjs [--only yunyang,elder] [--engine edge]
 * 依赖与 make-voice 相同（edge 需本机 edge-tts；gemini 需 GEMINI_API_KEY）。
 * 某把嗓子录失败不中断，结尾汇总哪台引擎可用、哪台缺什么。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const args = process.argv.slice(2);
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

// 标准试音词：四句覆盖钩子、低谷、巅峰、收束四种语气，两两并成头尾
const INTRO = "如果把一生画成K线，他这一生，涨停和跌停都拉满了。四十三岁，他跌到人生最低点，被全世界看空。";
const OUTRO = "可十年之后，他站上巅峰，整个时代为他让路。人生如线，起落之间，自有回响。";

const profiles = JSON.parse(readFileSync(join(ROOT, "tools", "voice-profiles.json"), "utf8"));
const only = flag("only", null)?.split(",").map((s) => s.trim());
const engineFilter = flag("engine", null);
const OUT_DIR = join(ROOT, "out", "auditions");
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (const [id, p] of Object.entries(profiles.styles)) {
  if (only && !only.includes(id)) continue;
  if (engineFilter && p.engine !== engineFilter) continue;
  if (p.engine === "elevenlabs" && /[^A-Za-z0-9_-]/.test(p.voice || "")) {
    results.push([id, p, "跳过", "占位音色，还没填真实 voice_id"]);
    continue;
  }
  const out = join(OUT_DIR, `${id}.wav`);
  const r = spawnSync(
    "node",
    [join(ROOT, "tools", "make-voice.mjs"), "--style", id, "--intro", INTRO, "--outro", OUTRO, "--total", "20", "--out", out],
    { encoding: "utf8", timeout: 180000 }
  );
  if (r.status === 0 && existsSync(out)) {
    // 压掉中间长静音，试音文件紧凑好听（失败就保留原文件）
    const compact = join(OUT_DIR, `${id}-compact.wav`);
    const f = spawnSync(
      "ffmpeg",
      ["-v", "error", "-y", "-i", out, "-af", "silenceremove=stop_periods=-1:stop_duration=0.8:stop_threshold=-45dB", compact],
      { encoding: "utf8" }
    );
    let dur = "?";
    try {
      const d = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f.status === 0 ? compact : out], { encoding: "utf8" });
      if (d.stdout) dur = Math.round(parseFloat(d.stdout.trim()) * 10) / 10 + "s";
    } catch {}
    results.push([id, p, "✓", `${f.status === 0 ? `${id}-compact.wav` : `${id}.wav`}（${dur}）`]);
  } else {
    const err = (r.stderr || r.stdout || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 160);
    results.push([id, p, "✗", err || "make-voice 失败（无输出）"]);
  }
}

console.log("试音结果（同一段词，文件在 out/auditions/）：");
for (const [id, p, ok, info] of results) console.log(`- ${ok} ${id}（${p.label}，引擎 ${p.engine}）：${info}`);
console.log("\n听完把要留的音色 id 告诉 Muse，它会固定成常用阵容写进音色库。");
console.log("提示：edge 引擎全灭多半是本机没装 edge-tts（pip install edge-tts）；gemini 失败先查 .env 里的 GEMINI_API_KEY。");
