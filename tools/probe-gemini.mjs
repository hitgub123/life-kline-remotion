#!/usr/bin/env node
/**
 * Gemini 连通性探针：用最朴素的请求依次测大脑主模型与备用模型，
 * 打印状态码、耗时与响应开头。大脑调用失败时先跑它定性：
 * 探针也失败 = 上游（谷歌服务 / 网络 / key）的问题；
 * 探针成功而大脑失败 = 大脑请求内容（对话历史、工具声明）的问题，来找 Muse。
 *
 * 用法: node tools/probe-gemini.mjs [模型名…]（不给参数测主模型＋备用模型）
 */
import { CFG } from "../agent/config.mjs";

const wanted = process.argv.slice(2);
const models = [...new Set(wanted.length ? wanted : [CFG.brainModel, "gemini-2.5-flash"])];
if (!CFG.geminiKey) {
  console.error("缺 GEMINI_API_KEY（仓库根目录 .env），没法测。");
  process.exit(1);
}
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
