#!/usr/bin/env node
/**
 * 选题：按「出生月日」查著名人物（古今中外），按热度排序输出候选。
 * 数据链：维基官方 OnThisDay 名单（英/中两版）给候选与条目 ID，
 * 再用 Wikidata 批量核验每人的出生月日（挡掉名单里的污染条目），
 * 并补全中文名、简介与热度（= 被多少种语言的维基百科收录，跨文化知名度指标）。
 * 已做过的人物会标「✓已做」；在世人物有标记。选好后 /make 名字 id 即可生产。
 *
 * 用法: node tools/topic-ideas.mjs [日期] [--min 热度下限] [--limit 条数]
 *   日期: 10-27 / 2026-10-27 / 省略=今天。只用月日，年份忽略。
 *   --min   默认 20（至少被 20 种语言维基收录）；挖冷门调低，只要顶流调高。
 *   --limit 默认 30。
 * 注意: 只收录出生日期有完整月日的条目；只有年份记载的古代人物不在此列。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flagVal = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : null;
};
const minLinks = parseInt(flagVal("min") || "20", 10);
const limit = parseInt(flagVal("limit") || "30", 10);

function parseMonthDay() {
  const raw = args.find((a) => /^\d{1,4}-\d{1,2}(-\d{1,2})?$/.test(a));
  const now = new Date();
  if (!raw) return { m: now.getMonth() + 1, d: now.getDate(), label: "今天" };
  const parts = raw.split("-").map(Number);
  const [m, d] = parts.length >= 3 ? [parts[1], parts[2]] : parts;
  if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
    console.error(`日期看不懂：${raw}（用 10-27 这种月-日格式）`);
    process.exit(1);
  }
  return { m, d, label: raw };
}
const { m, d, label } = parseMonthDay();
const pad = (n) => String(n).padStart(2, "0");

// 已做过的人物：脚本文件名 + 主角名，双路查重
const doneIds = new Set();
const doneNames = new Set();
const dataDir = join(ROOT, "src/data");
if (existsSync(dataDir)) {
  for (const f of readdirSync(dataDir)) {
    if (!f.endsWith(".json")) continue;
    doneIds.add(f.replace(/\.json$/, "").toLowerCase());
    try {
      const j = JSON.parse(readFileSync(join(dataDir, f), "utf8"));
      if (j.subject?.name) doneNames.add(j.subject.name);
    } catch {}
  }
}

const UA = { "User-Agent": "life-kline-factory/1.0 (topic selection)" };
async function getJson(url, ms = 30000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status} ${url.split("/").slice(0, 3).join("/")}`);
  return res.json();
}

// 1) 名单：英/中两版 OnThisDay 出生名单 → QID 集合（英文版的条目标题留作建议 id 素材）
const candidates = new Map(); // qid -> { enTitle }
for (const lang of ["en", "zh"]) {
  try {
    const feed = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/${lang}/onthisday/births/${pad(m)}/${pad(d)}`);
    for (const b of feed.births || []) {
      const page = (b.pages || [])[0];
      const qid = page?.wikibase_item;
      if (qid && !candidates.has(qid)) candidates.set(qid, { enTitle: lang === "en" ? page.titles?.canonical || page.title || "" : "" });
      else if (qid && lang === "en") candidates.get(qid).enTitle = page.titles?.canonical || page.title || "";
    }
  } catch (e) {
    console.error(`（${lang} 版名单没拉到：${e.message}，只用另一版）`);
  }
}
if (!candidates.size) {
  console.error("名单是空的——接口异常或这天没有条目，稍后再试。");
  process.exit(1);
}

// 2) 核验+补全：Wikidata 批量取标籤/简介/链接数/生卒（50 个一批）
const timeParts = (t) => {
  const mm = String(t || "").match(/^[+-]?(\d+)-(\d{2})-(\d{2})/);
  return mm ? { y: Number(mm[1]), m: Number(mm[2]), d: Number(mm[3]) } : null;
};
const people = [];
const qids = [...candidates.keys()];
for (let i = 0; i < qids.length; i += 50) {
  const batch = qids.slice(i, i + 50);
  const api = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join("|")}&props=labels|descriptions|sitelinks|claims&languages=zh|en&format=json`;
  const j = await getJson(api, 60000);
  for (const qid of batch) {
    const e = j.entities?.[qid];
    if (!e || e.missing) continue;
    const isHuman = (e.claims?.P31 || []).some((c) => c.mainsnak?.datavalue?.value?.id === "Q5");
    if (!isHuman) continue; // 名单污染（年份条目等）在这里被挡掉
    const births = (e.claims?.P569 || [])
      .map((c) => c.mainsnak?.datavalue?.value)
      .filter((v) => v && v.precision >= 11)
      .map((v) => timeParts(v.time))
      .filter(Boolean);
    const born = births.find((b) => b.m === m && b.d === d) || births[0];
    if (!born || born.m !== m || born.d !== d) continue; // 月日对不上，不收
    const deathT = e.claims?.P570?.[0]?.mainsnak?.datavalue?.value;
    const death = deathT ? timeParts(deathT.time) : null;
    const links = Object.keys(e.sitelinks || {}).length;
    if (links < minLinks) continue;
    const name = e.labels?.zh?.value || e.labels?.en?.value || qid;
    const enTitle = candidates.get(qid)?.enTitle || e.sitelinks?.enwiki?.title || "";
    const idBase = (enTitle || e.labels?.en?.value || "").replace(/_/g, " ").replace(/\s*\(.*?\)\s*/g, "").trim();
    const id =
      idBase
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // 剥掉重音符号：Niccolò→Niccolo、Inácio→Inacio
        .split(/\s+/)
        .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("") || "Unknown";
    const thisYear = new Date().getFullYear();
    const living = !death && thisYear - born.y < 110;
    people.push({
      name,
      years: death ? `${born.y}–${death.y}` : living ? `${born.y}–` : `${born.y}`,
      desc: e.descriptions?.zh?.value || e.descriptions?.en?.value || "",
      links,
      id,
      done: doneIds.has(id.toLowerCase()) || doneNames.has(name),
      living,
    });
  }
}
people.sort((a, b) => b.links - a.links);
const top = people.slice(0, limit);

console.log(`${m} 月 ${d} 日出生的著名人物（${label}，热度≥${minLinks}，共 ${top.length} 位，按热度排序）：\n`);
top.forEach((p, i) => {
  const tags = [p.done ? "✓已做" : "", p.living ? "在世" : ""].filter(Boolean).join(" ");
  console.log(`${String(i + 1).padStart(2)}. ${p.name}（${p.years}）热度 ${p.links}${tags ? " " + tags : ""}`);
  console.log(`    ${p.desc || "（无简介）"}  ·  建议 id: ${p.id}`);
});
console.log(`\n选好后在 Discord 里发 /make 名字 id 即可生产。注：只有年份、没有月日记载的古代人物不在此列。`);
