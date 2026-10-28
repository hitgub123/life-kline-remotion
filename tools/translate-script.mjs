#!/usr/bin/env node
/**
 * 多语言版：把一份中文脚本翻成日/英版，只翻文字层，K 线数据骨架一字不动。
 * 翻译范围：人物名/头衔/标签、关键点批注、每段标题句（保持原来的分行与分段结构）、
 * 底部名言（优先该人物广为人知的原语言原句或通行译本）、头尾旁白词。
 * 产物：src/data/<base>.<lang>.json（带 lang 标记，voice.style 按语言换音色），并注册 Composition。
 * 模板对 lang=en 自动换 Playfair Display 展示衬线；ja 沿用思源宋体（量产讲究时可换 JP 版字体）。
 *
 * 用法: node tools/translate-script.mjs src/data/elonmusk.json [--to ja,en] [--provider gemini|opencode] [--voice-style 音色id]
 * 通道口径与生成器一致：Gemini 3.8 主、DeepSeek Flash（Zen）备，失败自动切换（--provider 钉死则不切）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (mm && !process.env[mm[1]]) process.env[mm[1]] = mm[2].replace(/^["']|["']$/g, "");
  }
}
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const srcPath = args.find((a) => a.endsWith(".json"));
if (!srcPath) {
  console.error("用法: node tools/translate-script.mjs src/data/xxx.json [--to ja,en] [--provider gemini|opencode]");
  process.exit(1);
}
const targets = flag("to", "ja,en").split(",").map((s) => s.trim()).filter(Boolean);
const pinned = flag("provider", null);
const voiceOverride = flag("voice-style", null);
const LANGS = {
  ja: { name: "日语", suffix: "Ja", voice: "nanami", hint: "人名用日本通行的表記（例：イーロン・マスク）。标题句保持杂志式短句的力度与节奏，可用体言止め。" },
  en: { name: "英语", suffix: "En", voice: "aria", hint: "Names in standard English (e.g. Elon Musk). Headlines keep the punchy magazine tone, short lines." },
};

const src = JSON.parse(readFileSync(srcPath, "utf8"));
const fileBase = basename(srcPath, ".json");

// ---------- 提取待译文字（保持结构，数字骨架不进 LLM） ----------
const payload = {
  subject: {
    name: src.subject.name,
    title: src.subject.title,
    stock_label: src.subject.stock_label,
    series: src.subject.series,
  },
  keypoints: src.keypoints.map((k) => k[2]),
  headlines: src.segments.map((s) => s.headline.map((line) => line.map((run) => run[0]))),
  quotes: src.segments.map((s) => s.quote ?? null),
  voice: { intro: src.voice?.intro || "", outro: src.voice?.outro || "" },
};

function shapeOk(t) {
  try {
    if (!t || typeof t !== "object") return false;
    for (const k of ["name", "title", "stock_label", "series"]) if (typeof t.subject?.[k] !== "string" || !t.subject[k]) return false;
    if (!Array.isArray(t.keypoints) || t.keypoints.length !== payload.keypoints.length) return false;
    for (let i = 0; i < payload.keypoints.length; i++) {
      if ((payload.keypoints[i] === null) !== (t.keypoints[i] === null)) return false;
      if (t.keypoints[i] !== null && typeof t.keypoints[i] !== "string") return false;
    }
    if (!Array.isArray(t.headlines) || t.headlines.length !== payload.headlines.length) return false;
    for (let s = 0; s < payload.headlines.length; s++) {
      if (!Array.isArray(t.headlines[s]) || t.headlines[s].length !== payload.headlines[s].length) return false;
      for (let l = 0; l < payload.headlines[s].length; l++) {
        if (!Array.isArray(t.headlines[s][l]) || t.headlines[s][l].length !== payload.headlines[s][l].length) return false;
        if (!t.headlines[s][l].every((x) => typeof x === "string" && x)) return false;
      }
    }
    if (!Array.isArray(t.quotes) || t.quotes.length !== payload.quotes.length) return false;
    for (let i = 0; i < payload.quotes.length; i++) if ((payload.quotes[i] === null) !== (t.quotes[i] === null)) return false;
    if (typeof t.voice?.intro !== "string" || typeof t.voice?.outro !== "string") return false;
    return true;
  } catch {
    return false;
  }
}

// ---------- LLM 通道（与 generate-script 同口径） ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function callOnce(ch, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    if (ch === "opencode") {
      const key = process.env.OPENCODE_API_KEY;
      if (!key) throw new Error("缺 OPENCODE_API_KEY");
      const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.3,
        }),
      });
      if (!res.ok) throw new Error(`opencode API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return { by: "opencode/deepseek-v4.1-flash", text: j.choices[0].message.content };
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("缺 GEMINI_API_KEY");
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
    });
    if (!res.ok) throw new Error(`gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return { by: "gemini/gemini-3.8-flash", text: j.candidates[0].content.parts.map((p) => p.text || "").join("") };
  } finally {
    clearTimeout(timer);
  }
}
async function translate(lang, extraNudge = "") {
  const L = LANGS[lang];
  const prompt = `你是短视频文案译者。把下面这份「人生K线」脚本的文字从中文翻译成${L.name}，只输出同样结构的 JSON，不要任何解释。
规则：
- 结构必须与原文完全一致：headlines 的段数、每段行数、每行分段数都不许增减；null 保持 null。
- ${L.hint}
- quotes（底部名言）：若该人物有广为人知的${L.name}原句/通行译本与此句对应，优先用原句；没有就直译，保持简短有力。
- 数字、年龄、年份保持原样；语气保持原稿的锐利与节奏，不要译成说明书腔。
${extraNudge}
原文 JSON：
${JSON.stringify(payload)}`;
  const chain = pinned ? [pinned] : ["gemini", "opencode"];
  let lastErr = null;
  for (const ch of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { by, text } = await callOnce(ch, prompt);
        const t = text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
        if (!shapeOk(parsed)) throw new Error("译文结构与原文对不齐");
        return { by, data: parsed };
      } catch (e) {
        lastErr = e;
        console.error(`翻译通道 ${ch} 第 ${attempt + 1} 次失败：${e.message.split("\n")[0].slice(0, 140)}`);
        await sleep(1500);
      }
    }
  }
  throw lastErr;
}

// ---------- 注册 Composition（与 generate-script 同写法） ----------
function register(newBase, compId) {
  const regPath = join(ROOT, "src/data/registry.ts");
  let reg = readFileSync(regPath, "utf8");
  if (reg.includes(`id: "${compId}"`)) {
    console.log(`registry 里已有 ${compId}，跳过注册`);
    return;
  }
  const varName = compId[0].toLowerCase() + compId.slice(1);
  reg = reg.replace(/(\/\/ \[auto-imports\][^\n]*\n)/, `$1import ${varName} from "./${newBase}.json";\n`);
  reg = reg.replace(/(\/\/ \[auto-entries\][^\n]*\n)/, `$1  { id: "${compId}", data: ${varName} as unknown as ScriptData },\n`);
  if (!reg.includes(`from "./${newBase}.json"`)) throw new Error("registry 标记行丢了，注册失败");
  writeFileSync(regPath, reg);
  console.log(`已注册 Composition: ${compId}`);
}
function sourceCompId() {
  const reg = readFileSync(join(ROOT, "src/data/registry.ts"), "utf8");
  // 逐行配对：先找源文件的 import 变量名，再找用该变量注册的条目 id
  const imp = reg.match(new RegExp(`import ([A-Za-z0-9]+) from "\\./${fileBase}\\.json";`));
  if (imp) {
    const entry = reg.match(new RegExp(`\\{ id: "([A-Za-z0-9]+)", data: ${imp[1]} as unknown as ScriptData \\}`));
    if (entry) return entry[1];
  }
  return fileBase[0].toUpperCase() + fileBase.slice(1);
}

// ---------- 主流程 ----------
const today = new Date().toISOString().slice(0, 10);
for (const lang of targets) {
  const L = LANGS[lang];
  if (!L) {
    console.error(`不支持的语言：${lang}（只支持 ja/en）`);
    continue;
  }
  const { by, data } = await translate(lang);
  const out = JSON.parse(JSON.stringify(src));
  out.subject = { ...out.subject, ...data.subject };
  out.keypoints = out.keypoints.map((k, i) => [k[0], k[1], data.keypoints[i]]);
  out.segments = out.segments.map((s, i) => ({
    ...s,
    headline: s.headline.map((line, li) => line.map((run, ri) => [data.headlines[i][li][ri], run[1]])),
    quote: data.quotes[i],
  }));
  out.lang = lang;
  if (out.voice) out.voice = { ...out.voice, intro: data.voice.intro, outro: data.voice.outro, style: voiceOverride || L.voice };
  delete out.factcheck; // 审查印章属于中文原文，译本不继承
  out.translated = { from: `${fileBase}.json`, at: today, by };
  const newBase = `${fileBase}.${lang}`;
  writeFileSync(join(ROOT, "src/data", `${newBase}.json`), JSON.stringify(out, null, 2) + "\n");
  register(newBase, sourceCompId() + L.suffix);
  console.log(`✓ ${lang} 版已生成：src/data/${newBase}.json（翻译 ${by}，音色 ${out.voice?.style}）`);
}
