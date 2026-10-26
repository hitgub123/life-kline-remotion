#!/usr/bin/env node
/**
 * 事实核查：让「另一个模型」对照人物资料（维基摘录）审查脚本，自动修正错误。
 *
 * 为什么要异源：生成和审查用同一个模型，它会用同样的记忆错误肯定自己。
 * 默认审查方：有 DEEPSEEK_API_KEY 用 DeepSeek 官方，其次 OPENCODE_API_KEY
 * 走 OpenCode Zen 的免费 DeepSeek，都没有才用 Gemini（--provider 可指定）。
 *
 * 用法:
 *   node tools/fact-check.mjs src/data/sushi.json
 *   node tools/fact-check.mjs src/data/sushi.json --provider gemini
 *
 * 做什么: 读 src/data/people/<同名>.md（没有就先自动抓维基），把资料和脚本
 * 一起给审查模型，核对出生年、每个关键点的事件年份、标注、引句真伪、标题与
 * 配音文案里的事实性断言。审查模型返回问题清单和修正补丁，本工具只接受
 * 白名单字段的补丁（出生年、关键点年龄/标注、段落引句），且现值与补丁 from
 * 一致才应用。修正后在脚本里盖 factcheck 章，报告写到
 * src/data/people/<同名>.review.md。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 与 agent 共用仓库根目录的 .env（已在环境变量里的优先，不覆盖）
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const args = process.argv.slice(2);
const scriptPath = args.find((a) => !a.startsWith("--") && a.endsWith(".json"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
if (!scriptPath) {
  console.error("用法: node tools/fact-check.mjs src/data/xxx.json [--provider deepseek|opencode|gemini] [--model 模型名]");
  process.exit(1);
}
const pinnedProvider = flag("provider", null);
const pinnedModel = flag("model", null);
const DEFAULT_MODELS = {
  deepseek: "deepseek-chat",
  opencode: "deepseek-v4.1-flash",
  gemini: "gemini-3.8-flash",
};
const KEY_ENVS = {
  deepseek: "DEEPSEEK_API_KEY",
  opencode: "OPENCODE_API_KEY",
  gemini: "GEMINI_API_KEY",
};
// OpenAI 兼容通道：deepseek 是官方接口；opencode 是 OpenCode Zen 网关
// （key 在 opencode.ai 领；注意 Zen 免费模型禁止外部调用，只能用付费模型吃余额）
const OPENAI_COMPAT = {
  deepseek: { base: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY" },
  opencode: { base: "https://opencode.ai/zen/v1", keyEnv: "OPENCODE_API_KEY" },
};
// 审查方接力顺序：官方 DeepSeek → Zen 付费 DeepSeek → Gemini。
// 不指定 --provider 时按此顺序自动跳过失败的（没余额/限流），用谁审的就盖谁的章；
// 指定 --provider 则只用那一家，方便定位问题。
function candidates() {
  if (pinnedProvider) return [pinnedProvider];
  return ["deepseek", "opencode", "gemini"].filter((p) => process.env[KEY_ENVS[p]]);
}
const base = basename(scriptPath).replace(/\.json$/, "");
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
const personName = script.subject?.name || base;

const dossierPath = join(ROOT, "src/data/people", base + ".md");
if (!existsSync(dossierPath)) {
  console.log("没有人物资料，先抓维基……");
  execFileSync("node", [join(ROOT, "tools/fetch-person.mjs"), personName, "--id", base], { stdio: "inherit" });
}
if (!existsSync(dossierPath)) {
  console.error("人物资料仍不存在，无法核查。");
  process.exit(1);
}
const dossier = readFileSync(dossierPath, "utf8").slice(0, 9000);

const PROMPT = `你是事实核查员。下面给你一份维基百科资料摘录和一份「人生K线」视频脚本 JSON。逐项核对脚本中的事实：

1. subject.birth_year 是否与资料一致；
2. 每个 keypoints[i] 的隐含年份 = birth_year + 年龄 - 1，它标注的事件（或按曲线位置推断的事件）在那一年是否成立；年龄与事件年份对不齐就是错误；
3. keypoints 的标注文字是否属实；
4. 每段 quote 是否确为此人作品原文或有据可查的名言；查无此据、张冠李戴的必须改成 null；
5. headline、voice.intro、voice.outro 中的事实性断言（如某年做了某事）是否与资料矛盾。

只输出一个 JSON，不要解释：
{
  "verdict": "pass 或 issues",
  "issues": [ { "severity": "error 或 warn", "field": "如 keypoints[3]", "detail": "错在哪", "evidence": "资料中的依据" } ],
  "patches": [ { "path": "subject.birth_year 或 keypoints.<下标>.0(年龄) 或 keypoints.<下标>.2(标注) 或 segments.<下标>.quote", "from": 脚本中的现值（原样复制）, "to": 修正值（引句改 null 表示删除）, "reason": "为什么改" } ]
}
补丁只许动上面四类字段；拿不准的写进 issues 不要打补丁。没有问题时 issues 和 patches 都给空数组。

资料摘录：
${dossier}

脚本 JSON：
${JSON.stringify(script)}`;

async function callOne(p, model, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 240000);
  try {
    if (OPENAI_COMPAT[p]) {
      const { base, keyEnv } = OPENAI_COMPAT[p];
      const key = process.env[keyEnv];
      if (!key) throw new Error(`缺环境变量 ${keyEnv}`);
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      if (!res.ok) throw new Error(`${p} API ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content;
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
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
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

async function callReviewer(prompt) {
  const list = candidates();
  if (!list.length)
    throw new Error("没有任何可用的审查 key：DEEPSEEK_API_KEY / OPENCODE_API_KEY / GEMINI_API_KEY 至少配一个");
  let lastErr = null;
  for (const p of list) {
    const models = [pinnedModel || DEFAULT_MODELS[p]];
    for (const model of models) {
      console.log(`审查中（${p}/${model}，对照 ${base}.md）……`);
      try {
        const text = await callOne(p, model, prompt);
        return { text, provider: p, model };
      } catch (e) {
        lastErr = e;
        console.warn(`⚠ ${p}/${model} 调用失败：${String(e.message).slice(0, 220)}，自动换下一个`);
      }
    }
  }
  throw lastErr;
}

function extractJson(text) {
  const t = text.replace(/```json|```/g, "");
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("审查输出里没有 JSON");
  return JSON.parse(t.slice(s, e + 1));
}

const ALLOWED = [/^subject\.birth_year$/, /^keypoints\.\d+\.0$/, /^keypoints\.\d+\.2$/, /^segments\.\d+\.quote$/];
function applyPatch(root, patch) {
  if (!ALLOWED.some((re) => re.test(patch.path))) return { ok: false, why: "字段不在白名单" };
  const parts = patch.path.split(".");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  const last = parts[parts.length - 1];
  if (JSON.stringify(node[last]) !== JSON.stringify(patch.from))
    return { ok: false, why: `现值 ${JSON.stringify(node[last])} 与 from ${JSON.stringify(patch.from)} 不符` };
  node[last] = patch.to;
  return { ok: true };
}

const { text: raw, provider: usedProvider, model: usedModel } = await callReviewer(PROMPT);
let verdict;
try {
  verdict = extractJson(raw);
} catch (e) {
  writeFileSync(join(ROOT, "tools/last-review-output.txt"), raw);
  console.error("审查输出解析失败，原文已存 tools/last-review-output.txt：", e.message);
  process.exit(1);
}
const issues = verdict.issues || [];
const applied = [];
const skipped = [];
for (const p of verdict.patches || []) {
  const r = applyPatch(script, p);
  (r.ok ? applied : skipped).push({ ...p, ...(r.ok ? {} : { why: r.why }) });
}
script.factcheck = {
  by: `${usedProvider}/${usedModel}`,
  at: new Date().toISOString().slice(0, 10),
  verdict: issues.length ? "issues" : "pass",
  issues: issues.length,
  source: `src/data/people/${base}.md`,
};
writeFileSync(scriptPath, JSON.stringify(script, null, 2) + "\n");
const lines = [
  `# ${personName} · 事实核查报告`,
  ``,
  `- 审查方：${usedProvider}/${usedModel}，对照维基资料 src/data/people/${base}.md`,
  `- 结论：${issues.length ? `发现 ${issues.length} 处问题` : "未发现事实问题"}；已自动修正 ${applied.length} 处${skipped.length ? `，${skipped.length} 处补丁未应用` : ""}`,
  ``,
];
for (const i of issues) lines.push(`- [${i.severity}] ${i.field}：${i.detail}（依据：${i.evidence}）`);
if (applied.length) lines.push(``, `## 已应用的修正`);
for (const p of applied) lines.push(`- ${p.path}：${JSON.stringify(p.from)} → ${JSON.stringify(p.to)}（${p.reason}）`);
if (skipped.length) lines.push(``, `## 未应用的补丁`);
for (const p of skipped) lines.push(`- ${p.path}：${p.why}`);
writeFileSync(join(ROOT, "src/data/people", base + ".review.md"), lines.join("\n") + "\n");
console.log(
  `核查完成：${issues.length} 处问题，自动修正 ${applied.length} 处。报告 src/data/people/${base}.review.md`
);
