import libai from "./libai.json";
import newton from "./newton.json";
// [auto-imports] 新脚本的 import 由 tools/generate-script.mjs 插到标记行下面，不要删标记
import { ScriptData } from "../lib/series";

export const SCRIPTS: { id: string; data: ScriptData }[] = [
  { id: "LifeKline", data: libai as unknown as ScriptData },
  { id: "Newton", data: newton as unknown as ScriptData },
  // [auto-entries] 新脚本的注册项由 tools/generate-script.mjs 插到标记行下面，不要删标记
];
