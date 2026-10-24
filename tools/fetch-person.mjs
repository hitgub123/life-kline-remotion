#!/usr/bin/env node
/**
 * 人物资料抓取：从维基百科取人物条目全文，存成 src/data/people/<id 小写>.md。
 * 这份资料有两个用途：generate-script 生成脚本时当事实依据喂给模型；
 * fact-check 审查时当核对标准。没有它，模型只能凭记忆写，错误率明显更高。
 *
 * 用法:
 *   node tools/fetch-person.mjs "苏轼" --id SuShi
 *   node tools/fetch-person.mjs "牛顿" --id Newton --title "艾萨克·牛顿"
 *   node tools/fetch-person.mjs "Isaac Newton" --id Newton --lang en
 *
 * --title 是维基条目标题（缺省用人名）；中文条目缺失或太短时自动改抓英文版。
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
function flag(key, def) {
  const i = args.indexOf("--" + key);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const id = flag("id", null);
const title = flag("title", name);
const langPref = flag("lang", "zh");
const force = args.includes("--force");
if (!name || !id) {
  console.error('用法: node tools/fetch-person.mjs "人名" --id EnglishId [--title 条目标题] [--lang zh|en]');
  process.exit(1);
}
const outPath = join(ROOT, "src/data/people", id.toLowerCase() + ".md");
if (existsSync(outPath) && !force) {
  console.log("人物资料已存在，跳过（如需重抓加 --force）:", outPath);
  process.exit(0);
}

async function fetchWiki(lang, t) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&formatversion=2&redirects=1&titles=` +
    encodeURIComponent(t);
  const res = await fetch(url, {
    headers: { "User-Agent": "life-kline-remotion/1.0 (personal video project)" },
  });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  const j = await res.json();
  const page = j?.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  return { extract: page.extract, title: page.title };
}

let got = await fetchWiki(langPref, title);
let lang = langPref;
if ((!got || got.extract.length < 800) && langPref === "zh") {
  const en = await fetchWiki("en", title);
  if (en && (!got || en.extract.length > got.extract.length)) {
    got = en;
    lang = "en";
  }
}
if (!got) {
  console.error(`维基百科上没找到「${title}」的条目。用 --title 指定准确条目标题再试。`);
  process.exit(1);
}
const clean = got.extract.replace(/\n{3,}/g, "\n\n").trim().slice(0, 24000);
const today = new Date().toISOString().slice(0, 10);
const source = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(got.title)}`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `<!-- 人物资料：${name} | 来源：${source} | 抓取：${today} | 供 generate-script 引用、fact-check 核查 -->\n\n# ${name}\n\n${clean}\n`
);
console.log(`已保存人物资料: ${outPath}（${lang} 维基，正文 ${clean.length} 字，来源 ${source}）`);
