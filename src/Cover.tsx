import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Img,
  staticFile,
  useVideoConfig,
  delayRender,
  continueRender,
} from "remotion";
import type { ScriptData } from "./lib/series";

// 封面（静态图，remotion still 出图）：与主视频同一视觉语言——
// 宣纸底、宋体大字、朱红点缀。构图：顶部系列标 / 中部人名大字 + 生卒与走势缩略线 / 底部钩子句黑带。
// 三种规格由 Root.tsx 的三个 Composition 决定画布尺寸（B站 1600x1000、抖音 1200x1600、YouTube 1920x1080），
// 本组件只按画布宽高比例排版，variant 仅用于文件名/调试区分。
const INK = "#221E18";
const ACCENT = "#A31621";
const GRAY = "#6B6252";
const FAINT = "#8C8373";
const UP = "#A6282C";
const DOWN = "#225E44";
const PAPER_BG = "#EDE5D3";
const SERIF = "'Noto Serif SC', serif";

const FONT_FILES: { family: string; file: string; weight: string }[] = [
  { family: "Noto Serif SC", file: "fonts/NotoSerifSC-Regular.otf", weight: "400" },
  { family: "Noto Serif SC", file: "fonts/NotoSerifSC-Bold.otf", weight: "700" },
];

async function loadFonts(): Promise<void> {
  for (const f of FONT_FILES) {
    const face = new FontFace(f.family, `url(${staticFile(f.file)})`, { weight: f.weight });
    document.fonts.add(face);
    await face.load();
  }
  await document.fonts.ready;
}

let _mctx: CanvasRenderingContext2D | null = null;
function fitFontSize(text: string, weight: number, base: number, maxWidth: number): number {
  if (typeof document === "undefined") return base;
  if (!_mctx) _mctx = document.createElement("canvas").getContext("2d");
  if (!_mctx) return base;
  _mctx.font = `${weight} ${base}px ${SERIF}`;
  const w = _mctx.measureText(text).width;
  if (w <= maxWidth) return base;
  return Math.max(24, Math.floor(base * (maxWidth / w) * 0.995));
}

export const Cover: React.FC<{ scriptData: ScriptData; variant?: string }> = ({ scriptData }) => {
  const { width, height } = useVideoConfig();
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender("cover fonts"));
  useEffect(() => {
    loadFonts()
      .catch(() => {})
      .finally(() => {
        setReady(true);
        continueRender(handle);
      });
  }, [handle]);

  const D = scriptData;
  const name = D.subject.name;
  const portrait = height > width;
  const pad = Math.round(width * 0.07);
  const lastAge = D.keypoints.length ? D.keypoints[D.keypoints.length - 1][0] : 0;
  const deathYear = D.subject.birth_year + lastAge - 1;
  const yearsLabel = `${D.subject.birth_year} — ${deathYear}`;

  // 走势缩略线：keypoints 折线（年龄→x，际遇指数→y）
  const chartW = width - pad * 2;
  const chartH = Math.round(height * (portrait ? 0.3 : 0.34));
  const vals = D.keypoints.map((k) => k[1]);
  const ages = D.keypoints.map((k) => k[0]);
  const vMin = Math.min(...vals);
  const vMax = Math.max(...vals);
  const aMin = Math.min(...ages);
  const aMax = Math.max(...ages);
  const X = (a: number) => pad + ((a - aMin) / Math.max(1, aMax - aMin)) * chartW;
  const Y = (v: number) => (1 - (v - vMin) / Math.max(1, vMax - vMin)) * (chartH - 20) + 10;
  const pts = D.keypoints.map((k) => `${X(k[0])},${Y(k[1])}`).join(" ");
  const peak = D.keypoints.reduce((a, b) => (b[1] > a[1] ? b : a), D.keypoints[0]);
  const valley = D.keypoints.reduce((a, b) => (b[1] < a[1] ? b : a), D.keypoints[0]);
  // 靠边标注改锚点方向并让开圆点，防文字出界/被点压住
  const anchorFor = (x: number): "start" | "middle" | "end" => (x > width * 0.8 ? "end" : x < width * 0.2 ? "start" : "middle");
  const labelX = (x: number) => x + (anchorFor(x) === "end" ? -18 : anchorFor(x) === "start" ? 18 : 0);

  const hook =
    D.voice?.intro ||
    (D.segments?.[0]?.headline || []).map((line) => line.map((r) => r[0]).join("")).join("");

  const nameBase = Math.min(width * (portrait ? 0.21 : 0.16), height * 0.17);
  const nameSize = ready ? fitFontSize(name, 700, nameBase, chartW) : nameBase;

  return (
    <AbsoluteFill style={{ backgroundColor: PAPER_BG, fontFamily: SERIF, color: INK }}>
      <Img src={staticFile("paper.png")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      {/* 顶部：朱红标 + 系列名 / 右侧股票标签 */}
      <div style={{ position: "absolute", top: pad * 0.75, left: pad, right: pad, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(width * 0.012) }}>
          <div style={{ width: Math.round(width * 0.014), height: Math.round(width * 0.014), backgroundColor: ACCENT }} />
          <div style={{ fontSize: Math.round(width * 0.026), color: GRAY, letterSpacing: 2 }}>{D.subject.series || "人生切片"} · 人生K线</div>
        </div>
        <div style={{ fontSize: Math.round(width * 0.022), color: FAINT }}>{D.subject.stock_label}</div>
      </div>
      {/* 人名大字 */}
      <div style={{ position: "absolute", top: height * (portrait ? 0.13 : 0.15), left: pad, right: pad }}>
        <div style={{ fontSize: nameSize, fontWeight: 700, lineHeight: 1.08 }}>{name}</div>
        <div style={{ marginTop: Math.round(height * 0.018), fontSize: Math.round(width * 0.03), color: GRAY }}>
          {D.subject.title}　{yearsLabel}
        </div>
      </div>
      {/* 走势缩略线 */}
      <svg style={{ position: "absolute", top: height * (portrait ? 0.4 : 0.42), left: 0 }} width={width} height={chartH + Math.round(width * 0.05)}>
        <polygon points={`${pad},${chartH} ${pts} ${pad + chartW},${chartH}`} fill={ACCENT} opacity={0.07} />
        <polyline points={pts} fill="none" stroke={ACCENT} strokeWidth={Math.max(4, width * 0.004)} strokeLinejoin="round" strokeLinecap="round" />
        {peak && <circle cx={X(peak[0])} cy={Y(peak[1])} r={Math.max(6, width * 0.006)} fill={UP} />}
        {valley && <circle cx={X(valley[0])} cy={Y(valley[1])} r={Math.max(6, width * 0.006)} fill={DOWN} />}
        {peak && (
          <text x={labelX(X(peak[0]))} y={Math.max(22, Y(peak[1]) - 16)} textAnchor={anchorFor(X(peak[0]))} fontFamily={SERIF} fontSize={Math.round(width * 0.024)} fill={UP}>
            {peak[0]}岁{peak[2] ? ` · ${peak[2]}` : ""}
          </text>
        )}
        {valley && (
          <text x={labelX(X(valley[0]))} y={Y(valley[1]) + Math.round(width * 0.045)} textAnchor={anchorFor(X(valley[0]))} fontFamily={SERIF} fontSize={Math.round(width * 0.024)} fill={DOWN}>
            {valley[0]}岁{valley[2] ? ` · ${valley[2]}` : ""}
          </text>
        )}
      </svg>
      {/* 底部钩子句黑带 */}
      {hook ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(28,25,21,0.94)",
            padding: `${Math.round(height * 0.035)}px ${pad}px`,
          }}
        >
          <div style={{ fontSize: ready ? fitFontSize(hook, 400, Math.round(width * 0.034), chartW) : Math.round(width * 0.034), color: "#F3EEE2", lineHeight: 1.35 }}>{hook}</div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
