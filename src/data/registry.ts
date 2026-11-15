import libai from "./libai.json";
import newton from "./newton.json";
// [auto-imports] 新脚本的 import 由 tools/generate-script.mjs 插到标记行下面，不要删标记
import emperorTaizuOfSongEn from "./emperortaizuofsong.en.json";
import emperorTaizuOfSongJa from "./emperortaizuofsong.ja.json";
import emperorTaizuOfSong from "./emperortaizuofsong.json";
import guangxuEmperorEn from "./guangxuemperor.en.json";
import guangxuEmperorJa from "./guangxuemperor.ja.json";
import guangxuEmperor from "./guangxuemperor.json";
import claudeMonetEn from "./claudemonet.en.json";
import claudeMonetJa from "./claudemonet.ja.json";
import claudeMonet from "./claudemonet.json";
import zhangYimouEn from "./zhangyimou.en.json";
import zhangYimouJa from "./zhangyimou.ja.json";
import zhangYimou from "./zhangyimou.json";
import maYun from "./mayun.json";
import elonMuskEn from "./elonmusk.en.json";
import elonMuskJa from "./elonmusk.ja.json";
import elonMusk from "./elonmusk.json";
import xinQiJi from "./xinqiji.json";
import suShi from "./sushi.json";
import { ScriptData } from "../lib/series";

export const SCRIPTS: { id: string; data: ScriptData }[] = [
  { id: "LifeKline", data: libai as unknown as ScriptData },
  { id: "Newton", data: newton as unknown as ScriptData },
  // [auto-entries] 新脚本的注册项由 tools/generate-script.mjs 插到标记行下面，不要删标记
  { id: "EmperorTaizuOfSongEn", data: emperorTaizuOfSongEn as unknown as ScriptData },
  { id: "EmperorTaizuOfSongJa", data: emperorTaizuOfSongJa as unknown as ScriptData },
  { id: "EmperorTaizuOfSong", data: emperorTaizuOfSong as unknown as ScriptData },
  { id: "GuangxuEmperorEn", data: guangxuEmperorEn as unknown as ScriptData },
  { id: "GuangxuEmperorJa", data: guangxuEmperorJa as unknown as ScriptData },
  { id: "GuangxuEmperor", data: guangxuEmperor as unknown as ScriptData },
  { id: "ClaudeMonetEn", data: claudeMonetEn as unknown as ScriptData },
  { id: "ClaudeMonetJa", data: claudeMonetJa as unknown as ScriptData },
  { id: "ClaudeMonet", data: claudeMonet as unknown as ScriptData },
  { id: "ZhangYimouEn", data: zhangYimouEn as unknown as ScriptData },
  { id: "ZhangYimouJa", data: zhangYimouJa as unknown as ScriptData },
  { id: "ZhangYimou", data: zhangYimou as unknown as ScriptData },
  { id: "MaYun", data: maYun as unknown as ScriptData },
  { id: "ElonMuskEn", data: elonMuskEn as unknown as ScriptData },
  { id: "ElonMuskJa", data: elonMuskJa as unknown as ScriptData },
  { id: "ElonMusk", data: elonMusk as unknown as ScriptData },
  { id: "XinQiJi", data: xinQiJi as unknown as ScriptData },
  { id: "SuShi", data: suShi as unknown as ScriptData },
];
