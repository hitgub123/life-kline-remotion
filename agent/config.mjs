/**
 * Agent 配置：从仓库根目录 .env 读取（手写解析，不加依赖）。
 * 需要的键见 .env.example。密钥只进 .env，永远不提交进 git。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const owners = (process.env.OWNER_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const CFG = {
  token: process.env.DISCORD_BOT_TOKEN || "",
  guildId: process.env.DISCORD_GUILD_ID || "",
  ownerIds: new Set(owners),
  geminiKey: process.env.GEMINI_API_KEY || "",
  brainModel: process.env.BRAIN_MODEL || "gemini-3.8-flash",
  // 大脑备用通道：OpenCode Zen 上的 DeepSeek Flash（口径：模型只用 Gemini 3.8 与 DeepSeek Flash 两家）
  opencodeKey: process.env.OPENCODE_API_KEY || "",
  deepseekFlashModel: process.env.DEEPSEEK_FLASH_MODEL || "deepseek-v4-flash",
  demoPerUserDaily: parseInt(process.env.DEMO_PER_USER_DAILY || "1", 10),
  demoGlobalDaily: parseInt(process.env.DEMO_GLOBAL_DAILY || "5", 10),
};

export function isOwner(userId) {
  return CFG.ownerIds.has(userId);
}

export function missingConfig() {
  const miss = [];
  if (!CFG.token) miss.push("DISCORD_BOT_TOKEN");
  if (!CFG.geminiKey) miss.push("GEMINI_API_KEY");
  if (!owners.length) miss.push("OWNER_ID");
  return miss;
}
