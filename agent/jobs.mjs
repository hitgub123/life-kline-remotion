/**
 * 任务队列与状态：生产是重活（渲染按分钟计），所以串行排队、状态落盘。
 * state.json 记每个任务的阶段与客人的每日用量；进程重启时 running 的任务
 * 会被标成 interrupted 并自动重新入队——断点续跑，不丢单。
 * 本模块不懂 Discord，只通过 hooks 往外报进度，由 bot.mjs 翻译成消息。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, CFG, isOwner } from "./config.mjs";

const STATE_PATH = join(ROOT, "agent/state.json");
let state = { jobs: [], usage: {} };
if (existsSync(STATE_PATH)) {
  try {
    state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    state = { jobs: [], usage: {} };
  }
}
function save() {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

let hooks = { onEnqueue: () => {}, onStart: () => {}, onStep: () => {}, onDone: () => {}, onFail: () => {}, onMixed: () => {} };
export function setHooks(h) {
  hooks = { ...hooks, ...h };
}

let seq = state.jobs.reduce((m, j) => Math.max(m, j.seq || 0), 0);
let working = false;

export function enqueue({ name, personId, requestedBy, channelId, guest }) {
  const ahead = state.jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const job = {
    seq: ++seq,
    name,
    personId,
    base: personId.toLowerCase(),
    requestedBy,
    channelId,
    guest: !!guest,
    status: "queued",
    createdAt: new Date().toISOString(),
    summary: null,
    resultPath: null,
  };
  state.jobs.push(job);
  save();
  hooks.onEnqueue(job, ahead);
  pump();
  return job;
}

export function getJob(seqNo) {
  return state.jobs.find((j) => j.seq === seqNo);
}
/** 回读磁盘上的任务记录（多进程同跑时以落盘状态为准，防重复通知）。 */
function persistedJob(seqNo) {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")).jobs.find((j) => j.seq === seqNo) || null;
  } catch {
    return null;
  }
}
/** 用户确认「就这样」：待补 BGM 的任务直接定稿。 */
export function finishJob(job) {
  job.status = "done";
  save();
  return job;
}
export function listJobs(limit = 10) {
  return state.jobs.slice(-limit).reverse();
}
export function awaitingBgmJobFor(userId) {
  return state.jobs.find((j) => j.requestedBy === userId && j.status === "awaiting_bgm");
}

/** 客人配额：演示模式每人每天 N 条、全局每天 M 条（config 可调）。 */
export function guestQuota(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const u = state.usage[userId];
  const mine = u && u.date === today ? u.count : 0;
  const global = Object.values(state.usage).reduce(
    (s, x) => s + (x.date === today ? x.count : 0),
    0
  );
  return {
    ok: mine < CFG.demoPerUserDaily && global < CFG.demoGlobalDaily,
    mine,
    global,
    perUser: CFG.demoPerUserDaily,
    globalCap: CFG.demoGlobalDaily,
  };
}
export function consumeGuestQuota(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const u = state.usage[userId];
  state.usage[userId] = { date: today, count: (u && u.date === today ? u.count : 0) + 1 };
  save();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let out = "";
    let lastStep = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      for (const line of d.toString().split(/\r?\n/)) {
        const m = line.match(/^=== (.+?) ===$/);
        if (m && m[1] !== lastStep) {
          lastStep = m[1];
          hooks.onStep(current, lastStep);
        }
      }
    });
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`退出码 ${code}\n${out.slice(-800)}`))
    );
  });
}

let current = null;
async function pump() {
  if (working) return;
  const job = state.jobs.find((j) => j.status === "queued");
  if (!job) return;
  working = true;
  current = job;
  job.status = "running";
  save();
  hooks.onStart(job);
  try {
    const out = await run("node", ["tools/produce.mjs", job.name, "--id", job.personId]);
    const m = out.match(/──────── 生产小结 ────────([\s\S]*)$/);
    job.summary = m ? m[1].trim() : "生产完成";
    const finalMp4 = join(ROOT, "out", `${job.base}-final.mp4`);
    const plainMp4 = join(ROOT, "out", `${job.base}.mp4`);
    job.resultPath = existsSync(finalMp4) ? finalMp4 : plainMp4;
    job.status = "awaiting_bgm";
    // 完成通知只发一次：重启恢复/多实例都可能让同一任务重复跑完，
    // 先落盘标记再通知，且通知前回读磁盘状态防两个进程同时抢发
    const disk = persistedJob(job.seq);
    const firstNotice = !job.notified && !(disk && disk.notified);
    if (firstNotice) job.notified = "done";
    save();
    if (firstNotice) hooks.onDone(job);
  } catch (e) {
    job.status = "failed";
    job.error = String(e.message || e).slice(0, 500);
    const disk = persistedJob(job.seq);
    const firstNotice = !job.notified && !(disk && disk.notified);
    if (firstNotice) job.notified = "failed";
    save();
    if (firstNotice) hooks.onFail(job);
  } finally {
    current = null;
    working = false;
    pump();
  }
}

/** 收到 BGM 文件后补混：不用重渲，几秒完成，任务转 done。 */
export async function mixBgmFor(job, bgmPath) {
  const args = [`out/${job.base}.mp4`, "--bgm", bgmPath, "--out", `out/${job.base}-final.mp4`];
  const voice = join(ROOT, "out", `${job.base}-voice.wav`);
  if (existsSync(voice)) args.push("--voice", `out/${job.base}-voice.wav`);
  await run("node", ["tools/mix-audio.mjs", ...args]);
  job.resultPath = join(ROOT, "out", `${job.base}-final.mp4`);
  job.status = "done";
  save();
  hooks.onMixed(job);
  return job;
}

/** 启动时恢复：上次没跑完的任务重新入队。 */
export function recover() {
  let changed = false;
  for (const j of state.jobs) {
    if (j.status === "running") {
      j.status = "queued";
      changed = true;
    }
  }
  if (changed) save();
  pump();
}

export { isOwner };
