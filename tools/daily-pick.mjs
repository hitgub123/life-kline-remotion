#!/usr/bin/env node
/**
 * 每日自动定版选题：给定日期（默认今天，Asia/Tokyo），自动选出当天要生产的 2 人。
 * 数据链与 tools/topic-ideas.mjs 完全一致（OnThisDay 名单 → Wikidata 核验 →
 * 黑名单硬过滤 → LLM 按中国知名度+人生起伏重排），差别在「定版」语义：
 * - 已生产过的人（src/data/registry.ts 已注册 id + src/data/*.json 及其中主角名）直接剔除，不只是打标；
 * - 历史已选过的人（tools/pick-history.json，本工具自维护）剔除，选后把本次结果追加记录；
 * - 生日池可选不足目标数时，用同一天忌日（OnThisDay deaths）池按同一套筛法补位；
 * - LLM 不可用时降级为热度序定版并注明（黑名单与查重仍生效，绝不绕过）。
 * HTTP 层：fetch 优先；若 fetch 整体不通（某些环境 Node 不走代理会黑洞），
 * 自动回退 curl 子进程，保证在本机与用户机上都能跑（回退会在 stderr 注明一次）。
 *
 * 用法: node tools/daily-pick.mjs [YYYY-MM-DD|MM-DD] [--count 2] [--min 20] [--no-rank] [--no-record]
 * 输出: 人读摘要 + `---JSON---` 后的机器可读 JSON（同时落盘 out/daily-pick-<日期>.json）。
 * JSON 形如 { date, count, picks: [{name, id, qid, source: "生日"|"忌日", reason, years, desc}], degraded?: bool }
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
const count = Math.max(1, parseInt(flagVal("count") || "2", 10) || 2);
const minLinks = parseInt(flagVal("min") || "20", 10);
const noRank = args.includes("--no-rank");
const noRecord = args.includes("--no-record");

// 日期：默认今天（Asia/Tokyo）；可给 YYYY-MM-DD 或 MM-DD（年份只用于记录，选题只看月日）
function parseDate() {
  const raw = args.find((a) => /^\d{1,4}-\d{1,2}(-\d{1,2})?$/.test(a));
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  if (!raw) return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const p = raw.split("-").map(Number);
  if (p.length === 3) return { y: p[0], m: p[1], d: p[2] };
  return { y: now.getFullYear(), m: p[0], d: p[1] };
}
const { y, m, d } = parseDate();
if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) {
  console.error("日期看不懂（用 2026-11-08 或 11-08）");
  process.exit(1);
}
const pad = (n) => String(n).padStart(2, "0");
const dateStr = `${y}-${pad(m)}-${pad(d)}`;

// ---------- 已做过的人：registry 已注册 id + src/data/*.json（文件名与主角名） ----------
const doneIds = new Set();
const doneNames = new Set();
const dataDir = join(ROOT, "src/data");
const regPath = join(dataDir, "registry.ts");
if (existsSync(regPath)) {
  const reg = readFileSync(regPath, "utf8");
  for (const mm of reg.matchAll(/\{ id: "([A-Za-z0-9]+)"/g)) doneIds.add(mm[1].toLowerCase());
  for (const mm of reg.matchAll(/from "\.\/([A-Za-z0-9.]+)\.json"/g)) doneIds.add(mm[1].toLowerCase());
}
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

// ---------- 历史已选：tools/pick-history.json ----------
const histPath = join(ROOT, "tools/pick-history.json");
let history = { picks: [] };
if (existsSync(histPath)) {
  try {
    history = JSON.parse(readFileSync(histPath, "utf8"));
    if (!Array.isArray(history.picks)) history.picks = [];
  } catch {}
}
const histQids = new Set(history.picks.map((p) => p.qid).filter(Boolean));
const histNames = new Set(history.picks.map((p) => p.name).filter(Boolean));
const histIds = new Set(history.picks.map((p) => (p.id || "").toLowerCase()).filter(Boolean));

// ---------- 黑名单（第一道筛，与 topic-ideas 同口径） ----------
const blPath = join(ROOT, "tools/topic-blacklist.json");
let blacklist = { entries: [] };
if (existsSync(blPath)) {
  try {
    blacklist = JSON.parse(readFileSync(blPath, "utf8"));
  } catch {}
}
const blHit = (p) =>
  blacklist.entries.find(
    (e) => (e.qid && e.qid === p.qid) || e.name === p.name || (e.aliases || []).includes(p.name) || (e.id || "").toLowerCase() === p.id.toLowerCase()
  );

// ---------- HTTP：fetch 优先，整体不通时回退 curl（只提示一次） ----------
const UA = { "User-Agent": "life-kline-factory/1.0 (daily pick)" };
let curlMode = false;
let curlNoted = false;
function curlJson(url, ms) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-sS", "--max-time", String(Math.ceil(ms / 1000)), "-H", `User-Agent: ${UA["User-Agent"]}`, url],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`curl 失败：${err.message.slice(0, 120)}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("curl 返回不是 JSON"));
        }
      }
    );
  });
}
async function getJson(url, ms = 30000) {
  if (!curlMode) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(Math.min(ms, 15000)) });
      if (!res.ok) throw new Error(`${res.status} ${url.split("/").slice(0, 3).join("/")}`);
      return await res.json();
    } catch (e) {
      // HTTP 状态错误说明网络是通的，不要回退；只有连接类失败才切 curl
      if (/^\d{3} /.test(e.message)) throw e;
      curlMode = true;
      if (!curlNoted) {
        curlNoted = true;
        console.error("（fetch 直连不通，已切换 curl 通道拉取数据）");
      }
    }
  }
  return curlJson(url, ms);
}

// ---------- 候选池：kind = births | deaths ----------
const timeParts = (t) => {
  const mm = String(t || "").match(/^[+-]?(\d+)-(\d{2})-(\d{2})/);
  return mm ? { y: Number(mm[1]), m: Number(mm[2]), d: Number(mm[3]) } : null;
};
async function gatherPool(kind) {
  const feedKey = kind; // OnThisDay 路径与字段同名：births / deaths
  const candidates = new Map();
  for (const lang of ["en", "zh"]) {
    try {
      const feed = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/${lang}/onthisday/${feedKey}/${pad(m)}/${pad(d)}`);
      for (const b of feed[feedKey] || []) {
        const page = (b.pages || [])[0];
        const qid = page?.wikibase_item;
        if (!qid) continue;
        if (!candidates.has(qid)) candidates.set(qid, { enTitle: lang === "en" ? page.titles?.canonical || page.title || "" : "" });
        else if (lang === "en") candidates.get(qid).enTitle = page.titles?.canonical || page.title || "";
      }
    } catch (e) {
      console.error(`（${lang} 版${kind === "births" ? "出生" : "忌日"}名单没拉到：${e.message}，只用另一版）`);
    }
  }
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
      const deaths = (e.claims?.P570 || [])
        .map((c) => c.mainsnak?.datavalue?.value)
        .filter((v) => v && v.precision >= 11)
        .map((v) => timeParts(v.time))
        .filter(Boolean);
      let born, death;
      if (kind === "births") {
        born = births.find((b) => b.m === m && b.d === d) || births[0];
        if (!born || born.m !== m || born.d !== d) continue;
        death = deaths[0] || null;
      } else {
        death = deaths.find((x) => x.m === m && x.d === d) || deaths[0];
        if (!death || death.m !== m || death.d !== d) continue;
        born = births[0] || null;
        if (!born) continue;
      }
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
        living,
        source: kind === "births" ? "生日" : "忌日",
      });
    }
  }
  people.sort((a, b) => b.links - a.links);
  return people;
}

// 剔除：黑名单（硬门）→ 已生产 → 历史已选
function usablePool(people) {
  const out = [];
  const dropped = { blacklist: 0, done: 0, history: 0 };
  for (const p of people) {
    if (blHit(p)) dropped.blacklist++;
    else if (doneIds.has(p.id.toLowerCase()) || doneNames.has(p.name)) dropped.done++;
    else if (histQids.has(p.qid) || histNames.has(p.name) || histIds.has(p.id.toLowerCase())) dropped.history++;
    else out.push(p);
  }
  return { out, dropped };
}

// ---------- 第二道筛：LLM 重排（与 topic-ideas 同提示词/同通道韧性） ----------
function rankPrompt(kindLabel, limitN) {
  return `你是中国短视频平台（抖音/B站/小红书）「人生K线」栏目的选题编辑，观众是中国普通用户。
给你一批候选人物（某月日${kindLabel}、已核验），你要做三件事：
1. 打分 china_fame（0-100）：此人在中国大众中的知名度——普通中国观众认不认识、会不会点开。
2. 打分 arc（0-100）：人生起伏是否适合画成K线——大起大落、命运转折多的高分，一生平顺的低分。
3. 风险筛查（命中即 excluded，一票否决）：近现代中国政治人物（两岸，含民国/国民党/中共领导人及家属）；在世或近二十年内任职的各国领导人、政客；恐怖分子；分裂势力、邪教人物；被中国平台封杀或有重大争议的在世人物。宁可错杀：拿不准的排除并写明原因。注意：已故历史人物（含希特勒等二战时期人物、历史独裁者）不因身份标签排除，按历史人物正常打分。
参考黑名单（工具已先行过滤，你负责查漏：别名、亲属、同类人物）：${blacklist.entries.map((e) => e.name).join("、")}
只输出 JSON，不要任何其他文字：
{"ranked":[{"name":"与候选完全一致的姓名","china_fame":0,"arc":0,"reason":"一句话推荐语"}],"excluded":[{"name":"...","why":"一句话原因"}]}
ranked 按综合推荐度从高到低，最多 ${limitN} 人；未入选的普通人物不用列，但敏感人物必须进 excluded。`;
}
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
// 返回定版顺序的人选（LLM 榜单优先；失败则热度序并标 degraded）
async function orderPool(pool, kindLabel) {
  if (noRank || !pool.length) return { ordered: pool, degraded: false, by: "" };
  const roster = pool.slice(0, 40).map((p) => ({ name: p.name, years: p.years, desc: p.desc, global_heat: p.links, living: p.living }));
  try {
    const { by, text } = await callRank(`${rankPrompt(kindLabel, 12)}\n\n候选（JSON）：\n${JSON.stringify(roster)}`);
    const t = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    const byName = new Map(pool.map((p) => [p.name, p]));
    const ranked = (parsed.ranked || [])
      .map((r) => ({ ...byName.get(r.name), china_fame: r.china_fame, arc: r.arc, reason: r.reason }))
      .filter((p) => p.name);
    // LLM 没点到名的候选按热度补在榜尾，保证池子够深
    const seen = new Set(ranked.map((p) => p.name));
    const rest = pool.filter((p) => !seen.has(p.name));
    // 被 LLM 放进 excluded 的不许从 rest 里溜回来
    const excl = new Set((parsed.excluded || []).map((x) => x.name));
    return { ordered: [...ranked, ...rest.filter((p) => !excl.has(p.name))], degraded: false, by };
  } catch (e) {
    console.error(`（LLM 过筛没跑成：${e.message}。降级为热度序定版，黑名单与查重仍生效。）`);
    return { ordered: pool, degraded: true, by: "" };
  }
}

// ---------- 主流程 ----------
const picks = [];
let degraded = false;
let rankBy = "";
const birthAll = await gatherPool("births");
const birthPool = usablePool(birthAll);
console.error(
  `生日池：核验后 ${birthAll.length} 人 → 剔除 黑名单 ${birthPool.dropped.blacklist} / 已生产 ${birthPool.dropped.done} / 历史已选 ${birthPool.dropped.history} → 可用 ${birthPool.out.length} 人`
);
{
  const { ordered, degraded: dg, by } = await orderPool(birthPool.out, "出生");
  degraded = degraded || dg;
  if (by) rankBy = by;
  for (const p of ordered) {
    if (picks.length >= count) break;
    picks.push(p);
  }
}
if (picks.length < count) {
  const deathAll = await gatherPool("deaths");
  const pickedQids = new Set(picks.map((p) => p.qid));
  const deathPool = usablePool(deathAll.filter((p) => !pickedQids.has(p.qid)));
  console.error(
    `忌日池补位：核验后 ${deathAll.length} 人 → 剔除 黑名单 ${deathPool.dropped.blacklist} / 已生产 ${deathPool.dropped.done} / 历史已选 ${deathPool.dropped.history} → 可用 ${deathPool.out.length} 人`
  );
  const { ordered, degraded: dg, by } = await orderPool(deathPool.out, "逝世");
  degraded = degraded || dg;
  if (by) rankBy = rankBy || by;
  for (const p of ordered) {
    if (picks.length >= count) break;
    picks.push(p);
  }
}

const result = {
  date: dateStr,
  count,
  picks: picks.map((p) => ({
    name: p.name,
    id: p.id,
    qid: p.qid,
    source: p.source,
    years: p.years,
    desc: p.desc,
    reason: p.reason || (p.china_fame != null ? `中国知名度 ${p.china_fame} · 起伏 ${p.arc}` : `全球热度 ${p.links}（热度序定版）`),
  })),
  ...(rankBy ? { rankedBy: rankBy } : {}),
  ...(degraded ? { degraded: true } : {}),
};

// 记录历史（--no-record 只演算不落账）
if (picks.length && !noRecord) {
  for (const p of result.picks) history.picks.push({ date: dateStr, name: p.name, id: p.id, qid: p.qid, source: p.source });
  writeFileSync(histPath, JSON.stringify(history, null, 2) + "\n");
}
mkdirSync(join(ROOT, "out"), { recursive: true });
const outPath = join(ROOT, "out", `daily-pick-${dateStr}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

// 人读摘要
console.log(`\n🗓 ${dateStr} 每日定版（目标 ${count} 人${rankBy ? `，过筛 ${rankBy}` : ""}${degraded ? "，⚠ LLM 降级·热度序" : ""}）：`);
if (!picks.length) console.log("（今天没有可选的人——池子被黑名单/已生产/历史过滤清空了，放宽 --min 或换日期再试）");
result.picks.forEach((p, i) => {
  console.log(`${i + 1}. ${p.name}（${p.years}）· ${p.source} · id 建议 ${p.id}`);
  console.log(`   ${p.desc || "（无简介）"} · 入选理由：${p.reason}`);
});
console.log(`JSON：${outPath.replace(ROOT + "/", "")}${noRecord ? "（--no-record：未记入 pick-history）" : `，已记入 tools/pick-history.json`}`);
console.log("---JSON---");
console.log(JSON.stringify(result));
if (picks.length < count) process.exitCode = 2;
