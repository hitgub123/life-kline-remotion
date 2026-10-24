import React from "react";
import { LifeKline } from "../LifeKline";
import type { ScriptData } from "../lib/series";
import catalog from "./templates.json";

/**
 * 视频模板注册表：元数据（名称/适合人物/默认风格）在 templates.json 里（单一数据源，
 * 生成器和文档都读它）；这里只负责把 id 对应到渲染组件。
 * 新增模板：templates.json 加一项 + 这里注册一行组件。
 */
export interface TemplateDef {
  id: string;
  name: string;
  component: React.ComponentType<{ scriptData: ScriptData }>;
  suitableFor: string[];
  defaults: { bpm: number; voiceStyle: string; bgmStyle: string };
}

interface TemplateMeta {
  id: string;
  name: string;
  suitableFor: string[];
  defaults: { bpm: number; voiceStyle: string; bgmStyle: string };
}
const META = Object.fromEntries(
  (catalog.templates as TemplateMeta[]).map((t) => [t.id, t])
) as Record<string, TemplateMeta>;

const COMPONENTS: Record<string, TemplateDef["component"]> = {
  classic: LifeKline,
};

export const TEMPLATES: Record<string, TemplateDef> = Object.fromEntries(
  Object.entries(COMPONENTS).map(([id, component]) => [
    id,
    { ...META[id], id, component },
  ])
);

export function templateOf(data: { template?: string }): TemplateDef {
  return TEMPLATES[data.template ?? "classic"] ?? TEMPLATES.classic;
}
