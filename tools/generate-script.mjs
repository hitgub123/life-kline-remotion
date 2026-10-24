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
 * 注意: 模型写的年份和引文必须人工再核查一遍，校验只查结构，查不了史实。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  (provider === "deepseek" ? "deepseek-chat" : "gemini-3.8-flash");

if (!name || !id) {
  console.error('用法: node tools/generate-script.mjs "人名" --id EnglishId [--provider gemini|deepseek] [--dry-run] [--from-file 文件]');
  process.exit(1);
}
if (!/^[A-Za-z][A-Za-z0-9]*$/.test(id)) {
  console.error("--id 必须是英文标识符，例如 SuShi");
  process.exit(1);
}

// ---------- 提示词 ----------
const example = readFileSync(join(ROOT, "src/data/libai.json"), "utf8");
const SPEC = `你在为「人生K线」短视频写脚本。视频把一个人的一生画成股票K线图：宣纸底、宋体大标题叙事、密K线自动生长，1080x1920，约66秒，无旁白。你的产出是一份 JSON 脚本，渲染器只读脚本出图，所以字段必须严格合规。

字段规范：
- subject: { name 人名, title 固定"人生K线图", birth_year 出生年(公历整数), stock_label 片头副标(自编，如"唐宋八大家股份 · 代码 1037"), series 固定"人生切片" }
- hook_dur: 3.5，seed: 42，都不要改
- bpm: 120，写在顶层。渲染器按半拍网格（120 BPM 时 0.25 秒）安排蜡烛出现时刻，音乐也会按 120 BPM 生成来卡点，所以每段 dur 必须是 0.5 的整数倍（6、6.5、7 这类），保证段界落在拍点上
- keypoints: [[年龄, 指数, 标注或null], ...]，10到13个。指数是"人生股价"：开局8-10，全片巅峰45-50，谷底3-6，落差要大。标注只给最重要的节点，2-5个字。年龄口径：画面年份 = birth_year + 年龄 - 1，先定事件年份再反推年龄，两者必须对齐；事件年份必须符合史实，不要凭印象编。
- segments: 约10段，每段 { id: "s1"起顺排, dur: 6-7秒, kp: [from,to]关键点下标(从0起，相邻段首尾相接，第一段从0开始，最后一段kp是[末点,末点]), candles: 10-30, vol: 0.06-0.18(动荡段大、平稳段小), shape: 1(冲顶段1.5-1.7), headline, quote, stamp?, rocket? }
- headline: 大标题叙事句。结构是"行的数组，每行是[文本, 是否标红0或1]片段的数组"。一句白话叙事，有戏的词或股市词标红。每行片段文本合计不超过10个汉字(数字字母算半个)，超了会溢出画面，长句拆两行。
- quote: 底部白字，人物本人最有名的一句作品原文或名言，必须真实存在并核对出处；没有合适的就写 null，绝不编造。不超过15个汉字。
- 去世那一段加 "stamp": true；最后一段加 "rocket": true 且 candles 为 0。

只输出 JSON 本体，不要解释，不要 markdown 代码块。

参考样例（李白，注意 headline 的嵌套结构）：
${example}

任务：为「${name}」写脚本。先在心里核对他/她的关键事件与年份，再落成 JSON。`;

function buildPrompt() {
  return SPEC;
}

// ---------- 调 API ----------
async function callLLM(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    if (provider === "deepseek") {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) throw new Error("缺环境变量 DEEPSEEK_API_KEY");
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.7,
        }),
      });
      if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
      const j = await res.json();
      return j.choices[0].message.content;
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("缺环境变量 GEMINI_API_KEY");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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

const raw = fromFile ? readFileSync(fromFile, "utf8") : await callLLM(prompt);
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
if (data.bpm == null) data.bpm = 120;
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
⚠ 渲染前请人工核查一遍脚本里的事件年份与 quote 出处，模型会写错。`);
