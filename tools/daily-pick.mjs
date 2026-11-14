#!/usr/bin/env node
/**
 * 每日自动定版选题：给定日期（默认今天，Asia/Tokyo），按当天名人成色自动定版生产名单。
 * 数据链与 tools/topic-ideas.mjs 基本一致（OnThisDay 名单 → Wikidata 核验 →
 * 黑名单硬过滤 → LLM 按中国知名度+人生起伏重排），定版规则（作者 2026-11-08 定）：
 * - 人数不固定：china_fame 与 arc 双达标的「高成档」全部入选，封顶 PICK_CAP 个防算力爆掉；
 *   一个达标的都没有时保底取排名第 1（生产与发布脱钩，成片先囤成库存，发布节奏另行安排）；
 * - 不避已生产/已选过的人：同个人物隔段时间重做没有问题。tools/pick-history.json
 *   只做只读日志（记哪天选了谁，供查账），绝不用作过滤；
 * - 黑名单是内容红线，硬门照旧；
 * - LLM 不可用时降级：按全球热度分档定版并注明（黑名单仍生效）。
 *
 * 2026-11-14 改造（作者反馈：11-08 热度降级名单四人中国观众一个都不认识）：
 * - 生日池与忌日池每天并行合并（旧版忌日只在生日池为空时补位），供给翻倍；
 * - 双通道候选：全球热度榜之外单开「华人优先通道」（lane=cn，判定见 gatherPool），
 *   通道内热度门槛降到 CN_MIN_LINKS，两通道各取 LANE_TOP 人送 LLM，避免中国人物
 *   因多语言维基覆盖少，在见到 LLM 前就被全球热度截断；
 * - china_fame 改为严格的【姓名识别度】（见 rankPrompt 锚点）：只认普通中国观众
 *   对姓名本身的即时识别，作品名气/圈层名气/全球地位一律不顶账；
 * - 华人保额：高成档里若无华人通道人选、且有华人候选达 CN_KEEP_FAME/CN_KEEP_ARC，
 *   保底纳入 1 人（不硬塞未达标者）。
 * HTTP 层：fetch 优先；若 fetch 整体不通（某些环境 Node 不走代理会黑洞），
 * 自动回退 curl 子进程，保证在本机与用户机上都能跑（回退会在 stderr 注明一次）。
 *
 * 用法: node tools/daily-pick.mjs [YYYY-MM-DD|MM-DD] [--cap 4] [--min 20] [--no-rank] [--no-record]
 * 输出: 人读摘要 + `---JSON---` 后的机器可读 JSON（同时落盘 out/daily-pick-<日期>.json）。
 * JSON 形如 { date, thresholds, picks: [{name, id, qid, source, tier, china_fame, arc, reason}], degraded?: bool }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
// ── 定版分档阈值（可调常量；作者口径：双高全取、封顶防爆、保底 1 个）──
const TIER_FAME_MIN = 70; // 高成档：姓名识别度（china_fame）下限
const TIER_ARC_MIN = 60; // 高成档：人生起伏（arc）下限
const PICK_CAP = Math.max(1, parseInt(flagVal("cap") || "4", 10) || 4); // 每日入选上限（--cap 可覆盖）
const TIER_HEAT_MIN = 100; // LLM 无分数时的降级高成档：全球热度（维基收录语言数）下限
const minLinks = parseInt(flagVal("min") || "20", 10); // 全球通道热度下限（--min 可覆盖）
// ── 双通道（2026-11-14）：华人优先通道单独放行、单独占送审名额 ──
const CN_MIN_LINKS = 8; // 华人优先通道热度下限（中国本土人物多语言覆盖少，统一 20 会误杀）
const LANE_TOP = 25; // 每条通道送 LLM 评分的人数（全球 25 + 华人 25，去重后合并一份名单）
const CN_KEEP_FAME = 65; // 华人保额门槛：姓名识别度
const CN_KEEP_ARC = 55; // 华人保额门槛：人生起伏
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

// ---------- 历史日志：tools/pick-history.json（只记账，绝不用作过滤） ----------
const histPath = join(ROOT, "tools/pick-history.json");
let history = { picks: [] };
if (existsSync(histPath)) {
  try {
    history = JSON.parse(readFileSync(histPath, "utf8"));
    if (!Array.isArray(history.picks)) history.picks = [];
  } catch {}
}

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
        // 华人通道判定的原料（lane 在池子收齐后统一算，见下方 resolveLanes）：
        _cits: (e.claims?.P27 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean),
        _p19: (e.claims?.P19 || [])[0]?.mainsnak?.datavalue?.value?.id || null,
        _zhLabel: e.labels?.zh?.value || "",
        _zhDesc: e.descriptions?.zh?.value || "",
        _hasZhWiki: !!e.sitelinks?.zhwiki,
      });
    }
  }
  return resolveLanes(people);
}

// ── 华人优先通道判定（2026-11-14；QID 均经 Wikidata 实测核对）──
// 教训：不能拿"中文名是汉字"当信号——外国人的中文译名也是汉字（约翰·弥尔顿）。
// 可靠信号按强度：① 国籍 P27 含中国相关实体；② 出生地 P19 所属国家（P17）为中国相关
// 实体；③ 中文简介含 中国/中华/台湾/香港/华人/华裔 等字样；④ 纯汉字短名（2-4 字、
// 无间隔号，多为本名而非译名）且与日韩无涉（国籍/出生国不含日韩——石黑一雄式
// 日裔汉字名靠出生国 Q17 排除）。lane 只决定送审名额与保额资格，最终成色由
// LLM 的姓名识别度分数把关，启发式宁可略宽。
const CN_ENTS = ["Q148", "Q865", "Q13426199", "Q8733", "Q8646"]; // 中华人民共和国 / 台湾·中华民国 / 中华民国大陆时期 / 清朝 / 香港
const JPKR_ENTS = ["Q17", "Q884", "Q423"]; // 日本 / 韩国 / 朝鲜
async function resolveLanes(people) {
  // 批量解析出生地所属国家（P19 → P17）
  const p19ids = [...new Set(people.map((p) => p._p19).filter(Boolean))];
  const countryOf = new Map();
  for (let i = 0; i < p19ids.length; i += 50) {
    const batch = p19ids.slice(i, i + 50);
    try {
      const j = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join("|")}&props=claims&format=json`, 60000);
      for (const pid of batch) {
        const cs = (j.entities?.[pid]?.claims?.P17 || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
        if (cs.length) countryOf.set(pid, cs);
      }
    } catch {}
  }
  const out = [];
  for (const p of people) {
    const birthCountries = (p._p19 && countryOf.get(p._p19)) || [];
    const citCN = p._cits.some((q) => CN_ENTS.includes(q));
    const birthCN = birthCountries.some((q) => CN_ENTS.includes(q));
    // 注意：不用裸"民国"作信号——"大韓民國"会误伤韩国人物；中华民国靠 中華/中华 与国籍 QID 已覆盖
    const descCN = /中國|中国|中華|中华|台灣|台湾|香港|澳門|澳门|華人|华人|華裔|华裔/.test(p._zhDesc);
    const jpkrTied =
      p._cits.some((q) => JPKR_ENTS.includes(q)) || birthCountries.some((q) => JPKR_ENTS.includes(q));
    const nameCN = /^[一-鿿]{2,4}$/.test(p._zhLabel);
    p._cnStrong = citCN || birthCN || descCN; // 强信号（国籍/出生国/简介明示）；纯短名只是弱信号
    p.lane = p._hasZhWiki && (p._cnStrong || (nameCN && !jpkrTied)) ? "cn" : "global";
    // 全球通道按 minLinks 把关；华人通道放宽到 CN_MIN_LINKS（本土人物多语言覆盖天然少）
    if (p.links < minLinks && !(p.lane === "cn" && p.links >= CN_MIN_LINKS)) continue;
    delete p._cits;
    delete p._p19;
    delete p._zhLabel;
    delete p._zhDesc;
    delete p._hasZhWiki;
    out.push(p);
  }
  out.sort((a, b) => b.links - a.links);
  return out;
}

// 过门：只过黑名单硬门（内容红线）。已生产/已选过一律不避（作者定）。
function gatePool(people) {
  const out = [];
  let blocked = 0;
  for (const p of people) {
    if (blHit(p)) blocked++;
    else out.push(p);
  }
  return { out, blocked };
}

// ---------- 第二道筛：LLM 重排（与 topic-ideas 同提示词/同通道韧性） ----------
function rankPrompt(kindLabel, limitN) {
  return `你是中国短视频平台（抖音/B站/小红书）「人生K线」栏目的选题编辑，观众是中国普通用户。
给你一批候选人物（某月日${kindLabel}、已核验），你要做三件事：
1. 打分 china_fame（0-100）=【姓名识别度】：普通中国短视频用户（不是影迷、文学圈、学术圈中人）刷到这个姓名，不看任何介绍，能不能立刻说出"他是谁"。严格按下锚点校准，不许通胀：
   - 90-100：家喻户晓，姓名本身就是流量（鲁迅、爱因斯坦、马云、李小龙这一级）；
   - 75-89：大多数人听过这个名字，能对上大致领域；
   - 55-74：不少人听说过，但要给出作品或身份提示才想得起来；
   - 30-54：只知其作品不知其人（如只知道《德古拉》《飘》、不知道作者是谁），或只有某个圈子知道；
   - 0-29：普通中国观众基本没听过。
   全球名气、历史地位、作品名气都不等于姓名识别度；外国人物只在欧美或特定圈层有名的，按中国普通观众的实际认知打分，不要客气。候选里的 channel 字段只是候选来源通道，不许因此加分或减分。
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
// 双通道送审名单：全球通道与华人优先通道各取 LANE_TOP（pool 已按热度降序），
// 按 qid 去重合并——保证华人候选不被全球热度截断在 LLM 视野之外（2026-11-14 改造核心）。
function buildRoster(pool) {
  const picked = new Map();
  for (const p of pool.filter((x) => x.lane !== "cn").slice(0, LANE_TOP)) picked.set(p.qid, p);
  // 华人通道内强信号（国籍/出生国/简介明示）优先于纯短名弱信号，同级再按热度——
  // 防路易八世式短译名挤掉真正的中国人物（pool 本身已按热度排序，这里只做稳定分层）
  const cnLane = pool
    .filter((x) => x.lane === "cn")
    .sort((a, b) => Number(b._cnStrong || false) - Number(a._cnStrong || false) || b.links - a.links);
  for (const p of cnLane.slice(0, LANE_TOP)) picked.set(p.qid, p);
  return [...picked.values()].map((p) => ({
    name: p.name,
    years: p.years,
    desc: p.desc,
    global_heat: p.links,
    living: p.living,
    channel: p.lane === "cn" ? "华人优先" : "全球",
  }));
}

// 返回定版顺序的人选（LLM 榜单优先；失败则热度序并标 degraded）
async function orderPool(pool, kindLabel) {
  if (noRank || !pool.length) return { ordered: pool, degraded: false, by: "" };
  const roster = buildRoster(pool);
  // 诊断开关：DAILY_PICK_DEBUG_ROSTER=1 时只打印双通道送审名单并退出（查"为什么没选中国人"用）
  if (process.env.DAILY_PICK_DEBUG_ROSTER) {
    console.log(`送审名单 ${roster.length} 人（全球 ${roster.filter((r) => r.channel === "全球").length} / 华人优先 ${roster.filter((r) => r.channel === "华人优先").length}）：`);
    for (const r of roster) console.log(`  [${r.channel}] ${r.name}（${r.years}）热度 ${r.global_heat} · ${r.desc || "（无简介）"}`);
    process.exit(0);
  }
  try {
    const { by, text } = await callRank(`${rankPrompt(kindLabel, 16)}\n\n候选（JSON）：\n${JSON.stringify(roster)}`);
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
    console.error(`（LLM 过筛没跑成：${e.message}。降级为热度序定版，黑名单硬门仍生效。）`);
    return { ordered: pool, degraded: true, by: "" };
  }
}

// ---------- 分档定版：双高全取（封顶 PICK_CAP），无达标则保底第 1 名 ----------
// 华人保额（2026-11-14）：高成档已定版但无华人通道人选时，若有华人候选达到
// CN_KEEP_FAME/CN_KEEP_ARC，保底纳入 1 人（有空位则追加、满员则替换识别度最低者）；
// 没有达标者不硬塞——保额保的是"别漏掉够格的中国人物"，不是国籍配额。
function applyCnKeep(picks, scored) {
  if (!picks.length || picks.some((p) => p.lane === "cn")) return picks;
  const cand = scored
    .filter((p) => p.lane === "cn" && p.china_fame >= CN_KEEP_FAME && p.arc >= CN_KEEP_ARC)
    .sort((a, b) => b.china_fame - a.china_fame || b.arc - a.arc)[0];
  if (!cand) return picks;
  const kept = { ...cand, tier: "高成·华人保额" };
  if (picks.length < PICK_CAP) return [...picks, kept];
  const li = picks.reduce((mi, p, i) => (p.china_fame < picks[mi].china_fame ? i : mi), 0);
  const out = [...picks];
  out[li] = kept;
  return out;
}

function tierSelect(ordered) {
  if (!ordered.length) return [];
  const scored = ordered.filter((p) => p.china_fame != null && p.arc != null);
  if (scored.length) {
    const high = scored.filter((p) => p.china_fame >= TIER_FAME_MIN && p.arc >= TIER_ARC_MIN);
    if (high.length) return applyCnKeep(high.slice(0, PICK_CAP).map((p) => ({ ...p, tier: "高成" })), scored);
    return [{ ...ordered[0], tier: "保底" }];
  }
  // 无分数（LLM 降级）：按全球热度分档
  const hot = ordered.filter((p) => p.links >= TIER_HEAT_MIN);
  if (hot.length) return hot.slice(0, PICK_CAP).map((p) => ({ ...p, tier: "高成·热度降级" }));
  return [{ ...ordered[0], tier: "保底·热度降级" }];
}

// ---------- 主流程：生日池 + 忌日池每日并行合并（2026-11-14；忌日不再是补位） ----------
let degraded = false;
let rankBy = "";
const birthAll = await gatherPool("births");
const deathAll = await gatherPool("deaths");
const mergedByQid = new Map();
for (const p of [...birthAll, ...deathAll]) if (!mergedByQid.has(p.qid)) mergedByQid.set(p.qid, p); // 同日生卒者保留生日来源
const all = [...mergedByQid.values()].sort((a, b) => b.links - a.links);
const gated = gatePool(all);
const pool = gated.out;
const cnCount = pool.filter((p) => p.lane === "cn").length;
console.error(
  `合并池：核验后 ${all.length} 人（生日 ${birthAll.length} / 忌日 ${deathAll.length}）→ 黑名单拦下 ${gated.blocked} → 可用 ${pool.length} 人（华人优先通道 ${cnCount} 人）`
);
const orderedRes = await orderPool(pool, "出生或逝世");
degraded = degraded || orderedRes.degraded;
if (orderedRes.by) rankBy = orderedRes.by;
const picks = tierSelect(orderedRes.ordered);

const result = {
  date: dateStr,
  thresholds: { fameMin: TIER_FAME_MIN, arcMin: TIER_ARC_MIN, cap: PICK_CAP, heatMin: TIER_HEAT_MIN, cnKeepFame: CN_KEEP_FAME, cnKeepArc: CN_KEEP_ARC },
  pool: { total: pool.length, cnChannel: cnCount },
  picks: picks.map((p) => ({
    name: p.name,
    id: p.id,
    qid: p.qid,
    source: p.source,
    lane: p.lane || "global",
    tier: p.tier,
    ...(p.china_fame != null ? { china_fame: p.china_fame, arc: p.arc } : {}),
    years: p.years,
    desc: p.desc,
    reason:
      p.reason ||
      (p.china_fame != null ? `中国知名度 ${p.china_fame} · 起伏 ${p.arc}` : `全球热度 ${p.links}（热度序）`),
  })),
  ...(rankBy ? { rankedBy: rankBy } : {}),
  ...(degraded ? { degraded: true } : {}),
};

// 记入历史日志（只查账用，不参与任何过滤；--no-record 只演算不落账）
if (picks.length && !noRecord) {
  for (const p of result.picks) history.picks.push({ date: dateStr, name: p.name, id: p.id, qid: p.qid, source: p.source, tier: p.tier });
  writeFileSync(histPath, JSON.stringify(history, null, 2) + "\n");
}
mkdirSync(join(ROOT, "out"), { recursive: true });
const outPath = join(ROOT, "out", `daily-pick-${dateStr}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

// 人读摘要
console.log(
  `\n🗓 ${dateStr} 每日定版（高成档：知名度≥${TIER_FAME_MIN} 且 起伏≥${TIER_ARC_MIN}，封顶 ${PICK_CAP}，保底 1${rankBy ? `，过筛 ${rankBy}` : ""}${degraded ? "，⚠ LLM 降级·热度分档" : ""}）：`
);
if (!picks.length) console.log("（今天生日/忌日池都被黑名单或核验清空了，换日期或放宽 --min 再试）");
result.picks.forEach((p, i) => {
  const score = p.china_fame != null ? `知名度 ${p.china_fame} · 起伏 ${p.arc}` : `热度 ${picks[i].links}`;
  console.log(`${i + 1}. ${p.name}（${p.years}）· ${p.source}${p.lane === "cn" ? " · 华人通道" : ""} · 【${p.tier}】${score} · id 建议 ${p.id}`);
  console.log(`   ${p.desc || "（无简介）"} · 入选理由：${p.reason}`);
});
console.log(`JSON：${outPath.replace(ROOT + "/", "")}${noRecord ? "（--no-record：未记入 pick-history）" : `，已记入 tools/pick-history.json（仅日志）`}`);
console.log("---JSON---");
console.log(JSON.stringify(result));
if (!picks.length) process.exitCode = 2;
