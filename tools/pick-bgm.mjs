#!/usr/bin/env node
/**
 * 自动选曲：按脚本的 bgm_style 从曲库（assets/bgm/manifest.json）里挑一首。
 *
 * 入池条件：登记表里 auto=true、styles 含目标风格、且音频文件在本机真实存在。
 * 排序：高潮点落在 28–48 秒的优先（越接近 40 秒越好），其余按与 40 秒的
 * 距离；取前三名后按人物 id 哈希挑一首——同一个人重渲永远同一首（可复现），
 * 不同人物自然分散，不会全挤在一首上。
 * 目标风格无候选时回退曲库默认风格（bgm-styles.json 的 default），再没有
 * 返回 null（调用方走等人工送歌的老路）。
 *
 * 用法（调试）: node tools/pick-bgm.mjs src/data/elonmusk.json
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

export function pickBgm(root, script, personBase) {
  let manifest;
  let stylesCat = {};
  try {
    manifest = JSON.parse(readFileSync(join(root, "assets", "bgm", "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  try {
    stylesCat = JSON.parse(readFileSync(join(root, "tools", "bgm-styles.json"), "utf8"));
  } catch {}
  const want = script.bgm_style || stylesCat.default || "cinematic-piano";
  const chain = [...new Set([want, stylesCat.default || "cinematic-piano"])];
  for (const style of chain) {
    const cands = (manifest.tracks || []).filter(
      (t) => t.auto === true && (t.styles || []).includes(style) && existsSync(join(root, "assets", "bgm", t.file))
    );
    if (!cands.length) continue;
    const score = (t) => {
      if (t.climaxAt == null) return 60;
      const d = Math.abs(t.climaxAt - 40);
      return t.climaxAt >= 28 && t.climaxAt <= 48 ? d : 20 + d;
    };
    cands.sort((a, b) => score(a) - score(b) || a.file.localeCompare(b.file));
    const top = cands.slice(0, 3);
    let h = 0;
    for (const ch of personBase || "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const pick = top[h % top.length];
    return {
      file: pick.file,
      style,
      climaxAt: pick.climaxAt ?? null,
      duration: pick.duration ?? null,
      fallback: style !== want,
      candidates: cands.length,
    };
  }
  return null;
}

if (process.argv[1] && basename(process.argv[1]) === "pick-bgm.mjs") {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error("用法: node tools/pick-bgm.mjs src/data/<人物>.json");
    process.exit(1);
  }
  const script = JSON.parse(readFileSync(join(root, scriptPath), "utf8"));
  const base = basename(scriptPath).replace(/\.json$/, "");
  const pick = pickBgm(root, script, base);
  console.log(pick ? JSON.stringify(pick, null, 2) : "无候选（曲库无此风格的可用曲目，或文件不在本机）");
}
