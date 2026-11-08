#!/usr/bin/env node
/**
 * 封面生成：从人物脚本 JSON 出三张平台封面（静态图，Remotion still 渲染）。
 * 视觉与主视频一致：宣纸底、宋体人名大字、朱红走势缩略线、底部钩子句黑带。
 * 规格：B站 1600x1000（16:10）、抖音 1200x1600（3:4）、YouTube 1920x1080（16:9）。
 * 钩子句取脚本 voice.intro（缺失时用第一段标题文本兜底）。
 *
 * 用法: node tools/make-cover.mjs src/data/elonmusk.json [--only bili,douyin,yt] [--out out/covers]
 * 产物: <out>/<base>-cover-<spec>.png
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const srcArg = args.find((a) => a.endsWith(".json"));
if (!srcArg) {
  console.error("用法: node tools/make-cover.mjs src/data/xxx.json [--only bili,douyin,yt] [--out 目录]");
  process.exit(1);
}
const SPECS = {
  bili: { comp: "CoverBili", label: "B站 16:10 (1600x1000)" },
  douyin: { comp: "CoverDouyin", label: "抖音 3:4 (1200x1600)" },
  yt: { comp: "CoverYt", label: "YouTube 16:9 (1920x1080)" },
};
const only = flag("only", "bili,douyin,yt")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => SPECS[s]);
if (!only.length) {
  console.error(`--only 没有有效规格（可选 ${Object.keys(SPECS).join("/")}）`);
  process.exit(1);
}
const outDir = join(ROOT, flag("out", "out/covers"));
mkdirSync(outDir, { recursive: true });
const scriptPath = join(ROOT, srcArg);
const scriptData = JSON.parse(readFileSync(scriptPath, "utf8"));
const base = basename(srcArg, ".json");

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, shell: process.platform === "win32" });
    let tail = "";
    const on = (d) => {
      tail = (tail + d).slice(-800);
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(tail.trim().split("\n").slice(-2).join(" ") || `exit ${code}`))));
  });
}

let failed = 0;
for (const spec of only) {
  const { comp, label } = SPECS[spec];
  const propsPath = join(outDir, `.props-${base}-${spec}.json`);
  writeFileSync(propsPath, JSON.stringify({ scriptData, variant: spec }));
  const outPath = join(outDir, `${base}-cover-${spec}.png`);
  try {
    await run("npx", ["remotion", "still", comp, outPath.replace(ROOT + "/", ""), `--props=${propsPath.replace(ROOT + "/", "")}`]);
    console.log(`✓ ${label}：${outPath.replace(ROOT + "/", "")}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${label}：${e.message.slice(0, 200)}`);
  }
}
if (failed) process.exitCode = 1;
