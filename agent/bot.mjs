#!/usr/bin/env node
/**
 * Discord 入口：把聊天平台接到 Agent 大脑和任务队列上。
 * 交互分工（面试时可以讲的设计）：
 *   - 斜杠命令 / 按钮 = 确定性路径，快、稳、可预期；
 *   - 自然语言私信/@ = LLM 大脑路径，灵活，负责理解与转达；
 *   - 长任务（生产）异步推送结果，聊天永不阻塞。
 * 双模式：OWNER_ID 里的人是主人，全功能；其他人是客人（演示模式），
 * 只能选演示目录或消耗每日限量 live 生成。
 *
 * 配置见 agent/README.md 与 .env.example。缺 token 时打印配置指引后退出。
 */
import { writeFileSync, existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { ROOT, CFG, isOwner, missingConfig } from "./config.mjs";
import { setHooks, recover, listJobs, awaitingBgmJobFor, finishJob, mixBgmFor, guestQuota, consumeGuestQuota, enqueue } from "./jobs.mjs";
import { chat, listPeople } from "./brain.mjs";
import demoCatalog from "./demo-catalog.json" with { type: "json" };

const dryRun = process.argv.includes("--dry-run");
if (dryRun) {
  console.log("配置自检（--dry-run，不连接 Discord）：");
  console.log("  DISCORD_BOT_TOKEN:", CFG.token ? "已配置" : "未配置");
  console.log("  GEMINI_API_KEY:", CFG.geminiKey ? "已配置" : "未配置");
  console.log("  OWNER_ID:", CFG.ownerIds.size ? `${CFG.ownerIds.size} 人` : "未配置");
  console.log("  大脑模型:", CFG.brainModel);
  console.log("  演示限量: 每人每天", CFG.demoPerUserDaily, "条 / 全局每天", CFG.demoGlobalDaily, "条");
  for (const p of demoCatalog)
    console.log(`  演示目录: ${p.name}（${p.id}）${p.video ? (existsSync(join(ROOT, p.video)) ? " 预渲染 ✔" : " 预渲染文件缺失") : " live 生成"}`);
  process.exit(0);
}
const miss = missingConfig();
if (miss.length) {
  console.log(`还没配置好，缺: ${miss.join(", ")}`);
  console.log("照着 agent/README.md 的五步走，把值填进仓库根目录的 .env 再启动。");
  process.exit(0);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const statusMessages = new Map();
const heartbeats = new Map();
function stopHeartbeat(seq) {
  const t = heartbeats.get(seq);
  if (t) clearInterval(t);
  heartbeats.delete(seq);
}
function startHeartbeat(job, step) {
  stopHeartbeat(job.seq);
  const since = Date.now();
  const t = setInterval(async () => {
    const msg = statusMessages.get(job.seq);
    if (!msg) return stopHeartbeat(job.seq);
    const s = Math.round((Date.now() - since) / 1000);
    await msg.edit(`🎬 #${job.seq}「${job.name}」${step}……（已 ${s} 秒，还在跑）`).catch(() => {});
  }, 60000);
  heartbeats.set(job.seq, t);
}
async function channelOf(job) {
  return client.channels.fetch(job.channelId).catch(() => null);
}
async function sendVideo(channel, filePath, text) {
  const size = existsSync(filePath) ? statSync(filePath).size : 0;
  if (size && size <= 24 * 1024 * 1024) {
    await channel.send({ content: text, files: [{ attachment: filePath, name: basename(filePath) }] });
  } else {
    await channel.send(`${text}\n（成片 ${Math.round(size / 1048576)}MB 超过 Discord 附件上限，文件在 ${filePath}）`);
  }
}

setHooks({
  async onEnqueue(job, ahead) {
    if (!ahead) return; // 队列空着，onStart 马上就来，不重复出声
    const ch = await channelOf(job);
    if (ch) await ch.send(`📥 已入队 #${job.seq}「${job.name}」，前面还有 ${ahead} 个任务。`).catch(() => {});
  },
  async onStart(job) {
    const ch = await channelOf(job);
    if (!ch) return;
    statusMessages.set(job.seq, await ch.send(`🎬 #${job.seq}「${job.name}」开始生产……`).catch(() => null));
  },
  async onStep(job, step) {
    const ch = await channelOf(job);
    if (!ch) return;
    const text = `🎬 #${job.seq}「${job.name}」${step}……`;
    const prev = statusMessages.get(job.seq);
    if (prev) await prev.edit(text).catch(() => {});
    else statusMessages.set(job.seq, await ch.send(text).catch(() => null));
    startHeartbeat(job, step);
  },
  async onDone(job) {
    stopHeartbeat(job.seq);
    const ch = await channelOf(job);
    if (!ch) return;
    const head = `✅ #${job.seq}「${job.name}」出片了`;
    if (job.resultPath) await sendVideo(ch, job.resultPath, `${head}\n${job.summary || ""}`);
    else await ch.send(`${head}\n${job.summary || ""}`);
    await ch.send("把 BGM 发给我（mp3/wav 文件）我就合成最终版；不需要的话回复「就这样」。");
  },
  async onFail(job) {
    stopHeartbeat(job.seq);
    const ch = await channelOf(job);
    if (ch) await ch.send(`⚠️ #${job.seq}「${job.name}」生产失败：${(job.error || "").slice(0, 300)}`);
  },
  async onMixed(job) {
    const ch = await channelOf(job);
    if (ch && job.resultPath) await sendVideo(ch, job.resultPath, `🎵 #${job.seq}「${job.name}」最终版（已配 BGM）`);
  },
});

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("make")
    .setDescription("为一位人物生产人生K线视频")
    .addStringOption((o) => o.setName("name").setDescription("人物名，如 苏轼").setRequired(true))
    .addStringOption((o) => o.setName("id").setDescription("英文标识（拼音 CamelCase），可省略让管家处理")),
  new SlashCommandBuilder().setName("demo").setDescription("演示目录：选一位现成的人物"),
  new SlashCommandBuilder().setName("status").setDescription("查看生产任务状态"),
  new SlashCommandBuilder().setName("people").setDescription("已生成过的人物"),
].map((c) => c.toJSON());

function findIdByName(name) {
  const hit = demoCatalog.find((p) => p.name === name);
  if (hit) return hit.id;
  return null;
}

client.once("clientReady", async () => {
  console.log(`已登录: ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(CFG.token);
  const route = CFG.guildId
    ? Routes.applicationGuildCommands(client.application.id, CFG.guildId)
    : Routes.applicationCommands(client.application.id);
  await rest.put(route, { body: COMMANDS });
  console.log("斜杠命令已注册", CFG.guildId ? "（服务器内，立即生效）" : "（全局，传播可能需要几分钟）");
  recover();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith("demo:")) {
      const entry = demoCatalog.find((p) => p.id === interaction.customId.slice(5));
      if (!entry) return interaction.reply({ content: "这个人物不在演示目录里了。", ephemeral: true });
      if (entry.video && existsSync(join(ROOT, entry.video))) {
        await interaction.deferReply();
        return interaction.editReply({
          content: `「${entry.name}」· ${entry.blurb}`,
          files: [{ attachment: join(ROOT, entry.video), name: `${entry.id}.mp4` }],
        });
      }
      if (!isOwner(interaction.user.id)) {
        const q = guestQuota(interaction.user.id);
        if (!q.ok) return interaction.reply({ content: "演示模式今日 live 限量已满，明天再来。", ephemeral: true });
        consumeGuestQuota(interaction.user.id);
      }
      const job = enqueue({
        name: entry.name,
        personId: entry.id,
        requestedBy: interaction.user.id,
        channelId: interaction.channelId,
        guest: !isOwner(interaction.user.id),
      });
      return interaction.reply(`已入队 #${job.seq}，为「${entry.name}」现场生产，做好了会在这里推送。`);
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "make") {
      const name = interaction.options.getString("name");
      const id = interaction.options.getString("id") || findIdByName(name);
      if (!id) {
        // 目录里查不到这个名字：客人保持确定性拒绝；主人转交大脑，
        // 由它拼英文标识并派单（与私信用中文派活同一条路，不用记 id）
        if (!isOwner(interaction.user.id))
          return interaction.reply({
            content: `我不知道「${name}」的英文标识，请带上 id 再试（如 /make name:${name} id:SuShi）。`,
            ephemeral: true,
          });
        await interaction.deferReply();
        const answer = await chat(interaction.channelId, `（主人用 /make 点名）请为「${name}」生产一条视频，英文标识由你决定并调用 make_video 派单。`, {
          userId: interaction.user.id,
          isOwner: true,
          channelId: interaction.channelId,
        });
        return interaction.editReply(answer.slice(0, 1900));
      }
      if (!isOwner(interaction.user.id)) {
        const q = guestQuota(interaction.user.id);
        if (!q.ok) return interaction.reply({ content: "演示模式今日 live 限量已满。", ephemeral: true });
        consumeGuestQuota(interaction.user.id);
      }
      const job = enqueue({
        name,
        personId: id,
        requestedBy: interaction.user.id,
        channelId: interaction.channelId,
        guest: !isOwner(interaction.user.id),
      });
      return interaction.reply(`已入队 #${job.seq}：为「${name}」生产视频。`);
    }
    if (interaction.commandName === "demo") {
      const row = new ActionRowBuilder().addComponents(
        demoCatalog.map((p) =>
          new ButtonBuilder().setCustomId(`demo:${p.id}`).setLabel(p.name).setStyle(ButtonStyle.Primary)
        )
      );
      return interaction.reply({ content: "演示目录，点一位看成片（无预渲染的会现场生产）：", components: [row] });
    }
    if (interaction.commandName === "status") {
      const label = { queued: "排队中", running: "生产中", awaiting_bgm: "待补 BGM", done: "完成", failed: "失败" };
      const js = listJobs(8);
      return interaction.reply(
        js.length ? js.map((j) => `#${j.seq} ${j.name}：${label[j.status] || j.status}`).join("\n") : "还没有任务。"
      );
    }
    if (interaction.commandName === "people") return interaction.reply(listPeople());
  } catch (e) {
    console.error("interaction 出错:", e);
    if (interaction.isRepliable() && !interaction.replied)
      interaction.reply({ content: "处理出错了，稍后再试。", ephemeral: true }).catch(() => {});
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const userId = message.author.id;
  const awaiting = awaitingBgmJobFor(userId);

  const audio = [...message.attachments.values()].find(
    (a) => (a.contentType || "").startsWith("audio/") || /\.(mp3|wav|m4a)$/i.test(a.name || "")
  );
  if (audio && awaiting) {
    await message.reply(`收到 BGM，正在给 #${awaiting.seq}「${awaiting.name}」合成最终版……`);
    try {
      const buf = Buffer.from(await (await fetch(audio.url)).arrayBuffer());
      const bgmPath = join(ROOT, "out", `${awaiting.base}-bgm${extname(audio.name || ".mp3")}`);
      writeFileSync(bgmPath, buf);
      await mixBgmFor(awaiting, bgmPath);
    } catch (e) {
      await message.reply(`合成失败：${String(e.message || e).slice(0, 200)}`);
    }
    return;
  }

  const isDm = message.channel.isDMBased();
  const mentioned = message.mentions.has(client.user);
  if (!isDm && !mentioned) return;
  const text = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!text) return;

  if (awaiting && /^(就这样|不用了?|不需要|跳过)/.test(text)) {
    finishJob(awaiting);
    await message.reply(`好，#${awaiting.seq}「${awaiting.name}」就以当前版本定稿。`);
    return;
  }

  await message.channel.sendTyping().catch(() => {});
  const reply = await chat(message.channelId, text, {
    userId,
    isOwner: isOwner(userId),
    channelId: message.channelId,
  });
  await message.reply(reply.slice(0, 1900));
});

client.login(CFG.token).catch((e) => {
  console.error("登录失败:", e.message);
  console.error("多半是 token 不对，或没在开发者后台给机器人开启 MESSAGE CONTENT INTENT。见 agent/README.md。");
  process.exit(1);
});
