#!/usr/bin/env node
/**
 * 人生K线脚本生成工具
 *
 * 用法:
 *   node tools/generate-script.mjs "苏轼" --id SuShi
 *   GEMINI_API_KEY=xxx node tools/generate-script.mjs "苏轼" --id SuShi --provider gemini
 *   DEEPSEEK_API_KEY=xxx node tools/generate-script.mjs "苏轼" --id SuShi --provider deepseek
 *   node tools/generate-script.mjs "苏轼" --id SuShi --dry-run        只打印提示词，不调 API
 *   node tools/generate-script.mjs "苏轼" --id SuShi --from-file out.txt  把已有文本当模型输出导入
 *
 * 做什么: 按 docs/USAGE.md 的字段规范让 LLM 生成人物脚本 JSON，做结构校验后
 * 落到 src/data/<id 小写>.json，并自动注册进 src/data/registry.ts。
 * 若 src/data/people/<id 小写>.md 存在（tools/fetch-person.mjs 从维基抓的人物
 * 资料），会作为事实依据一并喂给模型；生成后建议跑 tools/fact-check.mjs 让
 * 另一个模型对照资料核查修正。结构校验查不了史实。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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


// ---------- 参数 ----------
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const id = flag("id", null);
const provider = flag("provider", "gemini");
const dryRun = args.includes("--dry-run");
const fromFile = flag("from-file", null);
const force = args.includes("--force");
const model =
  flag("model", null) ||
  (provider === "deepseek"
    ? "deepseek-chat"
    : provider === "opencode"
      ? "deepseek-v4.1-flash"
      : "gemini-3.8-flash");

if (!name || !id) {
  console.error('用法: node tools/generate-script.mjs "人名" --id EnglishId [--provider gemini|deepseek|opencode] [--no-fallback] [--dry-run] [--from-file 文件]');
  process.exit(1);
}
if (!/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
  console.error("--id 必须是英文标识符，例如 SuShi");
  process.exit(1);
}

// ---------- 提示词 ----------
// 目录单一数据源：模板读 src/data/templates.json，音色读 tools/voice-profiles.json，
// BGM 风格读 tools/bgm-styles.json。以后加模板/音色/风格只改目录文件，不改本工具。
const example = readFileSync(join(ROOT, "src/data/libai.json"), "utf8");
const TEMPLATE_CATALOG = JSON.parse(readFileSync(join(ROOT, "src/data/templates.json"), "utf8"));
const TEMPLATE_LINES = TEMPLATE_CATALOG.templates
  .map((t) => `- ${t.id} ${t.name}：适合${t.suitableFor.join("、")}`)
  .join("\n");
const TEMPLATE_IDS = TEMPLATE_CATALOG.templates.map((t) => t.id);
const TEMPLATE_DEFAULTS = Object.fromEntries(TEMPLATE_CATALOG.templates.map((t) => [t.id, t.defaults]));
const VOICE_PROFILES = JSON.parse(readFileSync(join(ROOT, "tools/voice-profiles.json"), "utf8"));
const VOICE_STYLE_LINES = Object.entries(VOICE_PROFILES.styles)
  .map(([id, p]) => `- ${id} ${p.label}：${p.note}`)
  .join("\n");
const BGM_STYLES = JSON.parse(readFileSync(join(ROOT, "tools/bgm-styles.json"), "utf8"));
const BGM_STYLE_LINES = Object.entries(BGM_STYLES.styles)
  .map(([id, p]) => `- ${id} ${p.label}：${p.note}`)
  .join("\n");

const SPEC = `你在为「人生K线」短视频写脚本。视频把一个人的一生画成股票K线图：宣纸底、宋体大标题叙事、密K线自动生长，1080x1920，约66秒，正片无旁白、仅头尾两句配音。你的产出是一份 JSON 脚本，渲染器只读脚本出图，所以字段必须严格合规。

字段规范：
- subject: { name 人名, title 固定"人生K线图", birth_year 出生年(公历整数), stock_label 片头副标(自编，如"唐宋八大家股份 · 代码 1037"), series 固定"人生切片" }
- hook_dur: 3.5，seed: 42，都不要改
- bpm: 120，写在顶层。渲染器按半拍网格（120 BPM 时 0.25 秒）安排蜡烛出现时刻，音乐也会按 120 BPM 生成来卡点，所以每段 dur 必须是 0.5 的整数倍（6、6.5、7 这类），保证段界落在拍点上
- keypoints: [[年龄, 指数, 标注或null], ...]，10到13个。指数是"人生股价"：开局8-10，全片巅峰45-50，谷底3-6，落差要大。标注只给最重要的节点，2-5个字。年龄口径：画面年份 = birth_year + 年龄 - 1，先定事件年份再反推年龄，两者必须对齐；事件年份必须符合史实，不要凭印象编。
- segments: 约10段，每段 { id: "s1"起顺排, dur: 6-7秒, kp: [from,to]关键点下标(从0起，相邻段首尾相接，第一段从0开始，最后一段kp是[末点,末点]), candles: 10-30, vol: 0.06-0.18(动荡段大、平稳段小), shape: 1(冲顶段1.5-1.7), headline, quote, stamp?, rocket? }
- headline: 大标题叙事句。结构是"行的数组，每行是[文本, 是否标红0或1]片段的数组"。一句白话叙事，有戏的词或股市词标红。每行片段文本合计不超过10个汉字(数字字母算半个)，超了会溢出画面，长句拆两行。
- quote: 底部白字，人物本人最有名的一句作品原文或名言，必须真实存在并核对出处；没有合适的就写 null，绝不编造。不超过15个汉字。
- voice: { intro, outro, style } 头尾配音文案与音色。intro: 一句钩子式介绍，必须点名人物，不超过24个汉字；outro: 结尾的总结与升华，40-70个汉字，不得复述 quote 原文，语气克制。style: 从下方音色清单里按人物气质选一个 id。
- template: 从下方模板清单里按人物选一个 id。
- bgm_style: 从下方 BGM 风格清单里按人物气质选一个 id（不要自己编风格描述，工具会按清单生成音乐标签）。

模板清单：
${TEMPLATE_LINES}

音色清单：
${VOICE_STYLE_LINES}

BGM 风格清单：
${BGM_STYLE_LINES}
- 去世那一段加 "stamp": true；最后一段加 "rocket": true 且 candles 为 0。

只输出 JSON 本体，不要解释，不要 markdown 代码块。

参考样例（李白，注意 headline 的嵌套结构）：
${example}

任务：为「${name}」写脚本。先在心里核对他/她的关键事件与年份，再落成 JSON。`;

function buildPrompt() {
  const dossierPath = join(ROOT, "src/data/people", id.toLowerCase() + ".md");
  if (existsSync(dossierPath)) {
    const text = readFileSync(dossierPath, "utf8").slice(0, 6000);
    return (
      SPEC +
      `\n\n事实依据（该人物的维基百科资料摘录）：事件与年份以此为准；摘录未覆盖的内容可谨慎使用公认史实，但不得编造具体年份与引句。\n${text}`
    );
  }
  console.warn(`⚠ 没有 ${name} 的人物资料（src/data/people/${id.toLowerCase()}.md），纯凭模型记忆生成，史实错误风险高。建议先跑 tools/fetch-person.mjs 抓维基资料。`);
  return SPEC;
}

// ---------- 调 API ----------
async function callOnce(p, m, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    // OpenAI 兼容通道：deepseek=官方接口，opencode=OpenCode Zen 网关（DeepSeek Flash）
    const OPENAI_COMPAT = {
      deepseek: { base: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY" },
      opencode: { base: "https://opencode.ai/zen/v1", keyEnv: "OPENCODE_API_KEY" },
    };
    if (OPENAI_COMPAT[p]) {
      const { base, keyEnv } = OPENAI_COMPAT[p];
      const key = process.env[keyEnv];
      if (!key) throw new Error(`缺环境变量 ${keyEnv}`);
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: m,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.7,
        }),
      });
      if (!res.ok) throw new Error(`${p} API ${res.status}: ${await res.text()}`);
      const j = await res.json();
      return j.choices[0].message.content;
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("缺环境变量 GEMINI_API_KEY");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.candidates[0].content.parts.map((p) => p.text || "").join("");
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 生成通道调度（口径：只用 Gemini 3.8 与 DeepSeek Flash 两家）：
// 同通道重试只对 429/5xx（过载类，缓一缓能好），超时/网络错误只重试 1 次；
// 主通道最终失败（除 400 请求错误外）自动跨厂切换备用通道。
// 注意：produce 流水线会显式传 --provider（那只是它的默认主通道，不是禁止切换），
// 所以守卫不能认 --provider；真要单通道跑，显式传 --no-fallback。
const FALLBACK_CHAIN = {
  gemini: ["opencode", "deepseek-v4.1-flash"],
  opencode: ["gemini", "gemini-3.8-flash"],
  deepseek: ["gemini", "gemini-3.8-flash"],
};
const KEY_ENVS = { gemini: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY", opencode: "OPENCODE_API_KEY" };
async function callLLM(prompt) {
  const chain = [[provider, model]];
  if (!args.includes("--no-fallback")) {
    const fb = FALLBACK_CHAIN[provider];
    if (fb && process.env[KEY_ENVS[fb[0]]]) chain.push(fb);
  }
  let lastErr = null;
  for (let ci = 0; ci < chain.length; ci++) {
    const [p, m] = chain[ci];
    if (ci > 0) console.error(`→ 自动切换备用通道 ${p}/${m}……`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = await callOnce(p, m, prompt);
        if (ci > 0) console.log(`✓ 已由备用通道 ${p}/${m} 生成`);
        return out;
      } catch (e) {
        lastErr = e;
        const status = Number(e.message.match(/API (\d{3})/)?.[1] || 0);
        console.error(`生成通道 ${p}/${m} 第 ${attempt} 次失败：${e.message.split("\n")[0].slice(0, 160)}`);
        if (status === 400) throw e; // 请求本身的问题，换通道也没用
        const retryable = status ? status === 429 || status >= 500 : attempt < 2;
        if (!retryable || attempt === 3) break;
        await sleep(attempt === 1 ? 2000 : 6000);
      }
    }
  }
  throw lastErr;
}

// ---------- 解析与校验 ----------
function extractJson(text) {
  const t = text.replace(/```json|```/g, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("输出里找不到 JSON 对象");
  return JSON.parse(t.slice(a, b + 1));
}

function textWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\x00-\xff]/.test(ch) ? 0.5 : 1;
  return w;
}

function validate(d) {
  const errors = [];
  const warns = [];
  if (!d.subject || !d.subject.name || !Number.isInteger(d.subject.birth_year))
    errors.push("subject 缺 name 或 birth_year");
  if (!Array.isArray(d.keypoints) || d.keypoints.length < 8 || d.keypoints.length > 15)
    errors.push("keypoints 应为 8 到 15 个");
  if (Array.isArray(d.keypoints)) {
    for (let i = 1; i < d.keypoints.length; i++)
      if (d.keypoints[i][0] <= d.keypoints[i - 1][0]) errors.push(`keypoints 年龄没有递增（第 ${i} 个）`);
    for (const kp of d.keypoints)
      if (kp[1] < 2 || kp[1] > 60) warns.push(`关键点指数 ${kp[1]} 超出常见区间 2-60`);
  }
  if (!Array.isArray(d.segments) || d.segments.length < 8 || d.segments.length > 12)
    errors.push("segments 应为 8 到 12 段");
  if (Array.isArray(d.segments) && Array.isArray(d.keypoints)) {
    if (d.segments[0].kp[0] !== 0) errors.push("第一段 kp 必须从 0 开始");
    for (let i = 1; i < d.segments.length; i++)
      if (d.segments[i].kp[0] !== d.segments[i - 1].kp[1])
        errors.push(`第 ${i + 1} 段 kp 与上一段没有首尾相接`);
    const last = d.segments[d.segments.length - 1];
    if (last.kp[1] !== d.keypoints.length - 1) errors.push("最后一段 kp 终点不是最后一个关键点");
    if (!last.rocket) warns.push("最后一段没有 rocket: true");
    if (!d.segments.some((s) => s.stamp)) warns.push("没有带 stamp 的段（去世段应有退市印章）");
    for (const s of d.segments) {
      if ((s.dur * 2) % 1 !== 0) warns.push(`段 ${s.id} 的 dur ${s.dur} 不是 0.5 的整数倍，段界会脱离拍点网格`);
      for (const line of s.headline || []) {
        const w = line.reduce((acc, run) => acc + textWidth(run[0]), 0);
        if (w > 10.5) warns.push(`段 ${s.id} 有一行标题宽 ${w.toFixed(1)}，超过 10 会溢出`);
      }
      if (s.quote && textWidth(s.quote) > 15.5) warns.push(`段 ${s.id} 的 quote 太长，会溢出`);
    }
    if (d.voice) {
      if (d.voice.intro && textWidth(d.voice.intro) > 26)
        warns.push("voice.intro 超过约 26 字，开头配音会拖太长");
      if (d.voice.outro && (textWidth(d.voice.outro) < 36 || textWidth(d.voice.outro) > 78))
        warns.push("voice.outro 宜在 40-70 字之间");
    }
    if (!d.bgm_style) warns.push("缺 bgm_style，工具将用模板默认风格");
    const total = (d.hook_dur || 0) + d.segments.reduce((a, s) => a + s.dur, 0);
    if (total < 55 || total > 80) warns.push(`总时长 ${total.toFixed(1)} 秒，不在 55-80 区间`);
  }
  return { errors, warns };
}

// ---------- 注册 ----------
function register(fileBase, compId) {
  const regPath = join(ROOT, "src/data/registry.ts");
  let reg = readFileSync(regPath, "utf8");
  if (reg.includes(`id: "${compId}"`)) {
    console.log(`registry 里已有 ${compId}，跳过注册`);
    return;
  }
  const varName = compId[0].toLowerCase() + compId.slice(1);
  reg = reg.replace(
    /(\/\/ \[auto-imports\][^\n]*\n)/,
    `$1import ${varName} from "./${fileBase}.json";\n`
  );
  reg = reg.replace(
    /(\/\/ \[auto-entries\][^\n]*\n)/,
    `$1  { id: "${compId}", data: ${varName} as unknown as ScriptData },\n`
  );
  if (!reg.includes(`from "./${fileBase}.json"`)) throw new Error("registry 标记行丢了，注册失败，请手动注册");
  writeFileSync(regPath, reg);
  console.log(`已注册 Composition: ${compId}`);
}

// ---------- 主流程 ----------
const prompt = buildPrompt();
if (dryRun) {
  console.log(prompt);
  process.exit(0);
}

let raw;
if (fromFile) {
  raw = readFileSync(fromFile, "utf8");
} else {
  try {
    raw = await callLLM(prompt);
  } catch (e) {
    // 只报一行原因，不让整页堆栈淹没真正的错误（Discord 失败消息会带上这行）
    console.error(`生成失败：${e.message.split("\n")[0]}`);
    process.exit(1);
  }
}
let data;
try {
  data = extractJson(raw);
} catch (e) {
  console.error("解析模型输出失败：", e.message);
  writeFileSync(join(ROOT, "tools/last-raw-output.txt"), raw);
  console.error("原始输出已存 tools/last-raw-output.txt");
  process.exit(1);
}
data.seed = 42;
data.hook_dur = 3.5;
if (!TEMPLATE_IDS.includes(data.template)) data.template = TEMPLATE_IDS[0];
const tdef = TEMPLATE_DEFAULTS[data.template] || {};
if (data.bpm == null) data.bpm = tdef.bpm ?? 120;
if (data.voice && !Object.hasOwn(VOICE_PROFILES.styles, data.voice.style || ""))
  data.voice.style = tdef.voiceStyle || VOICE_PROFILES.default || "yunyang";
if (!Object.hasOwn(BGM_STYLES.styles, data.bgm_style || ""))
  data.bgm_style = tdef.bgmStyle || BGM_STYLES.default;
data.bgm_tags = BGM_STYLES.styles[data.bgm_style].tags;
const { errors, warns } = validate(data);
for (const w of warns) console.warn("⚠", w);
if (errors.length) {
  for (const e of errors) console.error("✘", e);
  console.error("校验没过，没有写入。修好后可用 --from-file 重新导入。");
  writeFileSync(join(ROOT, "tools/last-raw-output.txt"), raw);
  process.exit(1);
}
const fileBase = id.toLowerCase();
const outPath = join(ROOT, `src/data/${fileBase}.json`);
if (existsSync(outPath) && !force) {
  console.error(`${outPath} 已存在，加 --force 覆盖`);
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
console.log(`脚本已写入 src/data/${fileBase}.json`);
register(fileBase, id);
console.log(`
下一步:
  抽帧检查: npx remotion still ${id} out/check.png --frame=1020
  渲染全片: npx remotion render ${id} out/${fileBase}.mp4
⚠ 渲染前请跑 tools/fact-check.mjs 让另一个模型对照人物资料核查年份与 quote，模型会写错。`);
