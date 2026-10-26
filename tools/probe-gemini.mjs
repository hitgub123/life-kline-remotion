#!/usr/bin/env node
/**
 * Gemini 连通性探针：用最朴素的请求依次测大脑主模型与备用模型，
 * 打印状态码、耗时与响应开头。大脑调用失败时先跑它定性：
 * 探针也失败 = 上游（谷歌服务 / 网络 / key）的问题；
 * 探针成功而大脑失败 = 大脑请求内容（对话历史、工具声明）的问题，来找 Muse。
 *
 * 用法: node tools/probe-gemini.mjs [模型名…]（不给参数只测大脑主模型）
 *       node tools/probe-gemini.mjs --list（列出这把 key 真实可用的文本模型，选备用靠它，别猜）
 */
import { CFG } from "../agent/config.mjs";

const wanted = process.argv.slice(2);
if (!CFG.geminiKey && wanted[0] !== "deepseek") {
  console.error("缺 GEMINI_API_KEY（仓库根目录 .env），没法测。");
  process.exit(1);
}
if (wanted[0] === "deepseek") {
  // 大脑备用通道体检：Zen 上的 DeepSeek Flash 回不回话
  if (!CFG.opencodeKey) {
    console.error("缺 OPENCODE_API_KEY（.env），没法测 DeepSeek 通道。");
    process.exit(1);
  }
  const t0 = Date.now();
  try {
    const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CFG.opencodeKey}` },
      body: JSON.stringify({ model: CFG.deepseekFlashModel, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await res.text();
    console.log(`deepseek（Zen/${CFG.deepseekFlashModel}）：状态 ${res.status}，耗时 ${Date.now() - t0}ms`);
    console.log(`  响应开头：${text.slice(0, 200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`deepseek（Zen/${CFG.deepseekFlashModel}）：网络错误，耗时 ${Date.now() - t0}ms，${e.message}`);
  }
  process.exit(0);
}
if (wanted[0] === "--list") {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": CFG.geminiKey },
    signal: AbortSignal.timeout(20000),
  });
  console.log(`模型名单接口：状态 ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const names = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
  console.log(names.length ? names.join("\n") : "（没拿到名单，看上面状态码）");
  process.exit(0);
}
const models = [...new Set(wanted.length ? wanted : [CFG.brainModel])];
for (const model of models) {
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", "x-goog-api-key": CFG.geminiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
      }
    );
    const text = await res.text();
    console.log(`${model}：状态 ${res.status}，耗时 ${Date.now() - t0}ms`);
    console.log(`  响应开头：${text.slice(0, 200).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`${model}：网络错误，耗时 ${Date.now() - t0}ms，${e.message}`);
  }
}
