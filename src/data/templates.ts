import React from "react";
import { LifeKline } from "../LifeKline";
import type { ScriptData } from "../lib/series";

/**
 * 视频模板注册表：一套模板 = 一个渲染组件 + 适用人物 + 默认风格三件套。
 * 脚本 JSON 的 template 字段选模板（缺省 classic）；生成器按人物气质选。
 * 新增模板：把组件放进这里注册一行即可，Root 会自动按脚本的 template 渲染。
 */
export interface TemplateDef {
  id: string;
  name: string;
  component: React.ComponentType<{ scriptData: ScriptData }>;
  suitableFor: string[];
  defaults: { bpm: number; voiceStyle: string; bgmTags: string };
}

export const TEMPLATES: Record<string, TemplateDef> = {
  classic: {
    id: "classic",
    name: "经典款 · 宣纸杂志风",
    component: LifeKline,
    suitableFor: ["古代人物", "文人", "科学家", "通用"],
    defaults: {
      bpm: 120,
      voiceStyle: "yunyang",
      bgmTags: "cinematic piano and strings, emotional, about the rises and falls of a great life",
    },
  },
};

export function templateOf(data: { template?: string }): TemplateDef {
  return TEMPLATES[data.template ?? "classic"] ?? TEMPLATES.classic;
}
