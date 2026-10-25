/**
 * Agent 落盘日志：终端会关、会滚屏，文件不会。
 * 全部写到 agent/logs/agent-<日期>.log（按天滚动），同时照常打到终端。
 * 出问题时把当天日志的最后几十行拿出来，就能定位是哪一步死的。
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.mjs";

const dir = join(ROOT, "agent", "logs");
mkdirSync(dir, { recursive: true });
const day = () => new Date().toISOString().slice(0, 10);
let streamDay = day();
let stream = createWriteStream(join(dir, `agent-${streamDay}.log`), { flags: "a" });
function ensureStream() {
  if (day() !== streamDay) {
    stream.end();
    streamDay = day();
    stream = createWriteStream(join(dir, `agent-${streamDay}.log`), { flags: "a" });
  }
}
const stamp = () => new Date().toTimeString().slice(0, 8);
function fmt(args) {
  return args
    .map((x) => (x instanceof Error ? x.stack || x.message : typeof x === "string" ? x : JSON.stringify(x)))
    .join(" ");
}
export function logLine(...args) {
  ensureStream();
  const s = `[${stamp()}] ${fmt(args)}`;
  console.log(s);
  stream.write(s + "\n");
}
export function logError(...args) {
  ensureStream();
  const s = `[${stamp()}] ERROR ${fmt(args)}`;
  console.error(s);
  stream.write(s + "\n");
}
export function logPath() {
  return join(dir, `agent-${day()}.log`);
}
