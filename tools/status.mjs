#!/usr/bin/env node
/**
 * 人物台账：一眼看清已经做了哪些人物、各自的资料/审查/成片状态。
 *
 * 用法: node tools/status.mjs
 * 状态来源: 脚本 src/data/<id>.json（含 factcheck 审查章）、
 * 资料与报告 src/data/people/、产物视频 out/、运行日志 out/logs/。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(ROOT, "src", "data");
const peopleDir = join(dataDir, "people");
const outDir = join(ROOT, "out");

const mb = (p) => (statSync(p).size / 1048576).toFixed(1) + "MB";
const rows = [];
for (const f of readdirSync(dataDir).filter((x) => x.endsWith(".json") && x !== "templates.json").sort()) {
  const base = f.replace(/\.json$/, "");
  let s;
  try {
    s = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
  } catch {
    rows.push(`- ${base}：⚠ 脚本 JSON 解析失败`);
    continue;
  }
  const dossier = existsSync(join(peopleDir, base + ".md")) ? "资料✓" : "资料✗";
  const fc = s.factcheck
    ? `审查✓ ${s.factcheck.verdict}（${s.factcheck.by}，问题 ${s.factcheck.issues} 处）`
    : "审查✗ 未审";
  const videos = [`out/${base}.mp4`, `out/${base}-final.mp4`]
    .filter((v) => existsSync(join(ROOT, v)))
    .map((v) => `${v} ${mb(join(ROOT, v))}`);
  const dur = (s.segments || []).reduce((a, x) => a + (x.dur || 0), 0);
  rows.push(
    `- ${s.subject?.name ?? base}（${s.subject?.birth_year ?? "?"} 年生，${dur.toFixed(1)}s）：${dossier}　${fc}　成片：${videos.length ? videos.join("，") : "无"}`
  );
}
console.log(`已建脚本的人物（${rows.length}）：`);
console.log(rows.join("\n") || "（无）");
