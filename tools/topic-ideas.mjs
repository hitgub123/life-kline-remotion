#!/usr/bin/env node
/**
 * 选题：按「出生月日」查著名人物（古今中外），过两道筛后按中国观众的口味排序输出。
 * 数据链：维基官方 OnThisDay 名单（英/中两版）给候选与条目 ID，
 * 再用 Wikidata 批量核验每人的出生月日（挡掉名单里的污染条目），
 * 并补全中文名、简介与全球热度（= 被多少种语言的维基百科收录）。
 * 两道筛：①黑名单硬过滤（tools/topic-blacklist.json，QID/名字/id 命中即除名）；
 * ②LLM 过筛重排（默认开）：按「中国大众知名度 + 人生起伏」打分重排，
 * 并把名单外的敏感人物（政治/争议/在世领导人等）一票否决，理由会公示，可审计。
 * 已做过的人物会标「✓已做」；在世人物有标记。选好后 /make 名字 id 即可生产。
 *
 * 用法: node tools/topic-ideas.mjs [日期] [--min 热度下限] [--limit 条数] [--no-rank]
 *   日期: 10-27 / 2026-10-27 / 省略=今天。只用月日，年份忽略。
 *   --min 默认 20；--limit 默认 12（LLM 榜单长度）；--no-rank 跳过 LLM，只出原始热度榜。
 * 注意: 只收录出生日期有完整月日的条目；只有年份记载的古代人物不在此列。
 * LLM 不可用（没 key/全失败）时自动降级为原始榜，并注明过筛未执行（黑名单仍生效）。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 工具自带 .env 加载（与仓库其他工具一致）：LLM 的 key 从这里来
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (mm && !process.env[mm[1]]) process.env[mm[1]] = mm[2].replace(/^["']|["']$/g, "");
  }
}
const args = process.argv.slice(2);
const flagVal = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : null;
};
const minLinks = parseInt(flagVal("min") || "20", 10);
const limit = parseInt(flagVal("limit") || "12", 10);
const noRank = args.includes("--no-rank");

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

// 黑名单（第一道筛）：QID / 名字（含别名）/ id 任一命中即除名
const blPath = join(ROOT, "tools/topic-blacklist.json");
let blacklist = { entries: [] };
if (existsSync(blPath)) {
  try {
    blacklist = JSON.parse(readFileSync(blPath, "utf8"));
  } catch {}
}
const blQids = new Set(blacklist.entries.map((e) => e.qid).filter(Boolean));
const blNames = new Set(blacklist.entries.flatMap((e) => [e.name, ...(e.aliases || [])]));
const blIds = new Set(blacklist.entries.map((e) => (e.id || "").toLowerCase()).filter(Boolean));
const blHit = (p) =>
  blacklist.entries.find(
    (e) => (e.qid && e.qid === p.qid) || e.name === p.name || (e.aliases || []).includes(p.name) || (e.id || "").toLowerCase() === p.id.toLowerCase()
  );

const UA = { "User-Agent": "life-kline-factory/1.0 (topic selection)" };
async function getJson(url, ms = 30000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status} ${url.split("/").slice(0, 3).join("/")}`);
  return res.json();
}

// 1) 名单：英/中两版 OnThisDay 出生名单 → QID 集合
const candidates = new Map();
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

// 2) 核验+补全：Wikidata 批量取标签/简介/链接数/生卒（50 个一批）
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
    if (!isHuman) continue;
    const births = (e.claims?.P569 || [])
      .map((c) => c.mainsnak?.datavalue?.value)
      .filter((v) => v && v.precision >= 11)
      .map((v) => timeParts(v.time))
      .filter(Boolean);
    const born = births.find((b) => b.m === m && b.d === d) || births[0];
    if (!born || born.m !== m || born.d !== d) continue;
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
        .replace(/[̀-ͯ]/g, "")
        .split(/\s+/)
        .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("") || "Unknown";
    const thisYear = new Date().getFullYear();
    const living = !death && thisYear - born.y < 110;
    people.push({
      qid,
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

// 第一道筛：黑名单硬过滤
const blocked = [];
const pool = [];
for (const p of people) {
  const hit = blHit(p);
  if (hit) blocked.push({ name: p.name, why: `黑名单·${hit.category}` });
  else pool.push(p);
}

// 3) 第二道筛 + 重排：LLM 按中国知名度与人生起伏打分，敏感者一票否决
const RANK_SYSTEM = `你是中国短视频平台（抖音/B站/小红书）「人生K线」栏目的选题编辑，观众是中国普通用户。
给你一批候选人物（某月日出生、已核验），你要做三件事：
1. 打分 china_fame（0-100）：此人在中国大众中的知名度——普通中国观众认不认识、会不会点开。
2. 打分 arc（0-100）：人生起伏是否适合画成K线——大起大落、命运转折多的高分，一生平顺的低分。
3. 风险筛查（命中即 excluded，一票否决）：近现代中国政治人物（两岸，含民国/国民党/中共领导人及家属）；在世或近二十年内任职的各国领导人、政客；独裁者、恐怖分子；分裂势力、邪教人物；被中国平台封杀或有重大争议的人物。宁可错杀：拿不准的排除并写明原因。
参考黑名单（工具已先行过滤，你负责查漏：别名、亲属、同类人物）：${blacklist.entries.map((e) => e.name).join("、")}
只输出 JSON，不要任何其他文字：
{"ranked":[{"name":"与候选完全一致的姓名","china_fame":0,"arc":0,"reason":"一句话推荐语"}],"excluded":[{"name":"...","why":"一句话原因"}]}
ranked 按综合推荐度从高到低，最多 ${limit} 人；未入选的普通人物不用列，但敏感人物必须进 excluded。`;
async function callRank(promptText) {
  const tries = [];
  if (process.env.GEMINI_API_KEY) tries.push("gemini");
  if (process.env.OPENCODE_API_KEY) tries.push("opencode");
  let lastErr = null;
  for (const ch of tries) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (ch === "gemini") {
          const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
            method: "POST",
            signal: AbortSignal.timeout(120000),
            headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptText }] }],
              generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
            }),
          });
          if (!res.ok) throw new Error(`gemini ${res.status}`);
          const j = await res.json();
          return { by: "gemini/gemini-3.8-flash", text: j.candidates[0].content.parts.map((p) => p.text || "").join("") };
        }
        const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
          method: "POST",
          signal: AbortSignal.timeout(120000),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENCODE_API_KEY}` },
          body: JSON.stringify({
            model: "deepseek-v4.1-flash",
            messages: [{ role: "user", content: promptText }],
            response_format: { type: "json_object" },
            temperature: 0.3,
          }),
        });
        if (!res.ok) throw new Error(`opencode ${res.status}`);
        const j = await res.json();
        return { by: "opencode/deepseek-v4.1-flash", text: j.choices[0].message.content };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error("没有可用的 LLM key");
}

let ranked = null;
let rankBy = "";
let llmExcluded = [];
if (!noRank && pool.length) {
  const roster = pool.slice(0, 40).map((p) => ({ name: p.name, years: p.years, desc: p.desc, global_heat: p.links, living: p.living }));
  try {
    const { by, text } = await callRank(`${RANK_SYSTEM}\n\n候选（JSON）：\n${JSON.stringify(roster)}`);
    const t = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    const byName = new Map(pool.map((p) => [p.name, p]));
    ranked = (parsed.ranked || [])
      .map((r) => ({ ...byName.get(r.name), china_fame: r.china_fame, arc: r.arc, reason: r.reason }))
      .filter((p) => p.name);
    llmExcluded = (parsed.excluded || []).filter((x) => byName.has(x.name));
    rankBy = by;
  } catch (e) {
    console.error(`（LLM 过筛没跑成：${e.message}。下面是原始热度榜，敏感筛查只执行了黑名单一道。）`);
  }
}

// 输出
const tags = (p) => [p.done ? "✓已做" : "", p.living ? "在世" : ""].filter(Boolean).join(" ");
if (ranked) {
  console.log(`${m} 月 ${d} 日选题榜（${label}，已按中国观众知名度重排 · 过筛 ${rankBy}）：\n`);
  ranked.forEach((p, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${p.name}（${p.years}）中国知名度 ${p.china_fame} · 起伏 ${p.arc} · 全球热度 ${p.links}${tags(p) ? " " + tags(p) : ""}`);
    console.log(`    ${p.desc || "（无简介）"}  ·  建议 id: ${p.id}`);
    if (p.reason) console.log(`    推荐语：${p.reason}`);
  });
  const shown = new Set(ranked.map((p) => p.name));
  const rest = pool.length - shown.size - llmExcluded.length;
  if (rest > 0) console.log(`\n（另有 ${rest} 位未入榜）`);
} else {
  console.log(`${m} 月 ${d} 日出生的著名人物（${label}，热度≥${minLinks}，按全球热度排序）：\n`);
  pool.slice(0, Math.max(limit, 30)).forEach((p, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${p.name}（${p.years}）热度 ${p.links}${tags(p) ? " " + tags(p) : ""}`);
    console.log(`    ${p.desc || "（无简介）"}  ·  建议 id: ${p.id}`);
  });
}
const allExcluded = [...blocked, ...llmExcluded.map((x) => ({ name: x.name, why: `LLM 过筛：${x.why}` }))];
if (allExcluded.length) {
  console.log(`\n—— 已筛掉（敏感/风险）——`);
  for (const x of allExcluded) console.log(`· ${x.name}：${x.why}`);
}
console.log(`\n选好后在 Discord 里发 /make 名字 id 即可生产。注：只有年份、没有月日记载的古代人物不在此列。`);
