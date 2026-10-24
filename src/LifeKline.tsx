import React, { useEffect, useMemo, useState } from "react";
import {
  AbsoluteFill,
  Img,
  continueRender,
  delayRender,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import libai from "./data/libai.json";
import {
  AnnoPlace,
  PX0,
  PX1,
  PY0,
  PY1,
  VY1,
  VY0,
  ScriptData,
  annoLayout,
  axisTarget,
  buildSeries,
  clamp01,
  domainTarget,
  easeOutCubic,
  fmtTick,
  niceAxis,
} from "./lib/series";

const INK = "#221E18";
const ACCENT = "#A31621";
const GRAY = "#6B6252";
const FAINT = "#8C8373";
const UP = "#A6282C";
const DOWN = "#225E44";
const SERIF = "'Noto Serif SC', serif";
const SANS = "'Noto Sans SC', sans-serif";
const BRUSH = "'Ma Shan Zheng', cursive";

const FONT_FILES: { family: string; file: string; weight: string }[] = [
  { family: "Noto Serif SC", file: "fonts/NotoSerifSC-Regular.otf", weight: "400" },
  { family: "Noto Serif SC", file: "fonts/NotoSerifSC-Bold.otf", weight: "700" },
  { family: "Noto Sans SC", file: "fonts/NotoSansSC-Bold.otf", weight: "700" },
  { family: "Ma Shan Zheng", file: "fonts/MaShanZheng.ttf", weight: "400" },
];

async function loadAllFonts(): Promise<void> {
  for (const f of FONT_FILES) {
    const face = new FontFace(f.family, `url(${staticFile(f.file)})`, {
      weight: f.weight,
    });
    document.fonts.add(face);
    await face.load();
  }
  await document.fonts.ready;
}

export const LifeKline: React.FC<{ scriptData?: ScriptData }> = ({ scriptData }) => {
  const DATA = scriptData ?? (libai as unknown as ScriptData);
  const BUILT = useMemo(() => buildSeries(DATA), [DATA]);
  const ANNOS = useMemo(() => annoLayout(BUILT.candles), [BUILT]);
  const ANNO_IDX = useMemo(() => new Set(ANNOS.keys()), [ANNOS]);
  // 涨停/跌停标签稀疏化：按涨跌幅从大到小取，彼此至少间隔 3 根蜡烛
  const TAG_SHOW = useMemo(() => {
    const cand = BUILT.candles
      .map((c, ci) => ({ ci, mag: Math.abs((c.c - c.o) / c.o) }))
      .filter((x) => BUILT.candles[x.ci].tag)
      .sort((a, b) => b.mag - a.mag);
    const picked = new Set<number>();
    for (const { ci } of cand) {
      if ([...picked].every((p) => Math.abs(p - ci) > 3)) picked.add(ci);
    }
    return picked;
  }, [BUILT]);

  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const [fontHandle] = useState(() => delayRender("Loading fonts"));
  useEffect(() => {
    loadAllFonts()
      .then(() => continueRender(fontHandle))
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("font load failed", e);
        continueRender(fontHandle);
      });
  }, [fontHandle]);

  const segs = DATA.segments;
  const starts = BUILT.segStarts;
  let si = -1;
  if (t >= DATA.hook_dur) {
    si = segs.length - 1;
    for (let i = 0; i < segs.length; i++) {
      if (t < starts[i] + segs[i].dur) {
        si = i;
        break;
      }
    }
  }
  const seg = si >= 0 ? segs[si] : null;
  const lt = si >= 0 ? t - starts[si] : 0;

  // 轴域与定义域：向本段目标平滑过渡（1.6 秒）
  let alo = 5;
  let ahi = 20;
  let step = 5;
  let dom = 24;
  if (si >= 0) {
    const p = easeOutCubic(clamp01(lt / 1.6));
    const prevA = si === 0 ? niceAxis(6, 18) : axisTarget(BUILT.candles, BUILT.cum[si - 1]);
    const curA = axisTarget(BUILT.candles, BUILT.cum[si]);
    const prevD = si === 0 ? 24 : domainTarget(DATA, BUILT, si - 1);
    const curD = domainTarget(DATA, BUILT, si);
    alo = prevA[0] + (curA[0] - prevA[0]) * p;
    ahi = prevA[1] + (curA[1] - prevA[1]) * p;
    step = curA[2];
    dom = prevD + (curD - prevD) * p;
  }
  const slot = (PX1 - PX0) / dom;
  const bodyW = Math.max(2.2, slot * 0.62);
  const X = (ci: number) => PX0 + slot * (ci + 0.5);
  const Y = (v: number) => PY1 - ((v - alo) / (ahi - alo)) * (PY1 - PY0);

  // 当前可见的最后一根蜡烛与展示值
  let lastCi = -1;
  let lastCloseDisp = 0;
  BUILT.candles.forEach((c, ci) => {
    if (t >= c.appear) {
      const p = easeOutCubic(clamp01((t - c.appear) / c.grow));
      lastCi = ci;
      lastCloseDisp = c.o + (c.c - c.o) * p;
    }
  });

  const ticks: number[] = [];
  if (si >= 0) {
    for (let v = Math.ceil(alo / step) * step; v <= ahi; v += step) ticks.push(v);
  }

  const uiOpacity = si < 0 ? 0 : si === 0 ? clamp01((t - starts[0]) / 0.6) : 1;
  const stampOn =
    seg?.stamp && lt > seg.dur - 1.4
      ? clamp01((lt - (seg.dur - 1.4)) / 0.28)
      : 0;
  const showDelist = (seg?.stamp && lt > seg.dur - 1.4) || seg?.rocket;

  const headline = (idx: number, opacity: number, blur: number) => {
    if (opacity <= 0) return null;
    return (
      <div
        style={{
          position: "absolute",
          top: 268,
          left: 88,
          right: 30,
          opacity,
          filter: blur > 0.1 ? `blur(${blur}px)` : undefined,
          fontFamily: SERIF,
          fontWeight: 700,
          fontSize: 94,
          color: INK,
        }}
      >
        {segs[idx].headline.map((line, li) => (
          <div key={li} style={{ lineHeight: "132px", whiteSpace: "nowrap" }}>
            {line.map(([txt, acc], ti) => (
              <span key={ti} style={{ color: acc ? ACCENT : INK }}>
                {txt}
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const quoteOpacity = (() => {
    if (!seg?.quote || si < 0) return 0;
    const aIn = clamp01((lt - 0.9) / 0.6);
    const aOut = clamp01((seg.dur - lt) / 0.4);
    return Math.min(aIn, aOut);
  })();

  const hookOpacity =
    t < DATA.hook_dur
      ? Math.min(clamp01(t / 0.6), clamp01((DATA.hook_dur - t) / 0.5))
      : 0;

  const rocketP = seg?.rocket ? clamp01((lt - 0.8) / 3.4) : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#EDE5D3" }}>
      <Img
        src={staticFile("paper.png")}
        style={{ position: "absolute", width: 1080, height: 1920 }}
      />

      <svg width={1080} height={1920} style={{ position: "absolute" }}>
        {/* 网格与轴标签 */}
        {ticks.map((v) => {
          const y = Y(v);
          if (y < PY0 - 4 || y > PY1 + 4) return null;
          return (
            <g key={v}>
              <line x1={PX0 - 46} y1={y} x2={PX1 + 34} y2={y} stroke="#786C58" strokeOpacity={0.4} strokeWidth={1} />
              <text x={PX0 - 58} y={y + 10} textAnchor="end" fontFamily={SERIF} fontSize={29} fill={FAINT}>
                {fmtTick(v, step)}
              </text>
            </g>
          );
        })}

        {/* 成交量与蜡烛 */}
        {BUILT.candles.map((c, ci) => {
          if (t < c.appear) return null;
          const p = easeOutCubic(clamp01((t - c.appear) / c.grow));
          const cur = c.o + (c.c - c.o) * p;
          const hi = Math.max(c.o, cur) + (c.h - Math.max(c.o, c.c)) * p;
          const lo = Math.min(c.o, cur) - (Math.min(c.o, c.c) - c.l) * p;
          const col = c.c >= c.o ? UP : DOWN;
          const cx = X(ci);
          const yTop = Y(Math.max(c.o, cur));
          const yBot = Y(Math.min(c.o, cur));
          const vh = (c.vol / BUILT.maxVol) * (VY1 - VY0);
          return (
            <g key={ci}>
              <rect x={cx - bodyW / 2} y={VY1 - vh} width={bodyW} height={vh} fill={col} fillOpacity={0.31} />
              <line x1={cx} y1={Y(hi)} x2={cx} y2={Y(lo)} stroke={col} strokeWidth={Math.max(1.6, slot * 0.1)} />
              <rect x={cx - bodyW / 2} y={yTop} width={bodyW} height={Math.max(2, yBot - yTop)} fill={col} />
            </g>
          );
        })}

        {/* 当前价虚线 */}
        {lastCi >= 0 && (
          <g>
            <line
              x1={X(lastCi) + bodyW / 2 + 4}
              y1={Y(lastCloseDisp)}
              x2={PX1 + 26}
              y2={Y(lastCloseDisp)}
              stroke={BUILT.candles[lastCi].c >= BUILT.candles[lastCi].o ? UP : DOWN}
              strokeWidth={2}
              strokeDasharray="11 8"
            />
            <text x={PX1 + 32} y={Y(lastCloseDisp) + 12} fontFamily={SERIF} fontSize={36} fill={INK}>
              ←
            </text>
          </g>
        )}

        {/* 涨停/跌停小标签 */}
        {BUILT.candles.map((c, ci) => {
          if (!c.tag || !TAG_SHOW.has(ci) || t < c.appear + c.grow) return null;
          if ([...ANNO_IDX].some((ai) => Math.abs(ci - ai) <= 2)) return null;
          const isUp = c.tag === "涨停";
          return (
            <text
              key={`tag${ci}`}
              x={X(ci)}
              y={isUp ? Y(c.h) - 9 : Y(c.l) + 29}
              textAnchor="middle"
              fontFamily={SERIF}
              fontSize={21}
              fill={isUp ? UP : DOWN}
              fillOpacity={0.85}
            >
              {c.tag}
            </text>
          );
        })}

        {/* 事件标注 */}
        {[...ANNOS.entries()].map(([ci, place]: [number, AnnoPlace]) => {
          const c = BUILT.candles[ci];
          if (t < c.appear + c.grow) return null;
          const a = clamp01((t - c.appear - c.grow) / 0.4);
          const cx = X(ci);
          if (place.side === 1) {
            const ty = Y(c.h) - 14 - place.level * 44 - 40;
            return (
              <g key={`anno${ci}`} opacity={a}>
                <line x1={cx} y1={Y(c.h) - 4} x2={cx} y2={ty + 42} stroke="#5A5242" strokeWidth={2} />
                <circle cx={cx} cy={Y(c.c)} r={3.5} fill={INK} />
                <text x={cx} y={ty + 31} textAnchor="middle" fontFamily={SERIF} fontSize={31} fill={INK}>
                  {c.anno}
                </text>
              </g>
            );
          }
          const ty = Y(c.l) + 14 + place.level * 44;
          return (
            <g key={`anno${ci}`} opacity={a}>
              <line x1={cx} y1={ty - 2} x2={cx} y2={Y(c.l) + 4} stroke="#5A5242" strokeWidth={2} />
              <circle cx={cx} cy={Y(c.c)} r={3.5} fill={INK} />
              <text x={cx} y={ty + 31} textAnchor="middle" fontFamily={SERIF} fontSize={31} fill={INK}>
                {c.anno}
              </text>
            </g>
          );
        })}

        {/* 结尾虚线冲顶 */}
        {rocketP > 0 &&
          (() => {
            const x0 = X(BUILT.candles.length - 1);
            const y0 = Y(BUILT.candles[BUILT.candles.length - 1].c);
            const x1 = PX1 - 6;
            const y1 = PY0 + 8;
            const xe = x0 + (x1 - x0) * rocketP;
            const ye = y0 + (y1 - y0) * rocketP;
            return (
              <g>
                <line x1={x0} y1={y0} x2={xe} y2={ye} stroke={ACCENT} strokeWidth={4} strokeDasharray="14 10" />
                <circle cx={xe} cy={ye} r={6} fill={ACCENT} />
              </g>
            );
          })()}
      </svg>

      {/* 顶部 UI */}
      {uiOpacity > 0 && (
        <div style={{ position: "absolute", inset: 0, opacity: uiOpacity }}>
          <div
            style={{
              position: "absolute",
              top: 146,
              left: 88,
              fontFamily: SERIF,
              fontSize: 33,
              letterSpacing: 10,
              color: GRAY,
            }}
          >
            {DATA.subject.series}
          </div>
          {lastCi >= 0 && (
            <>
              <div style={{ position: "absolute", top: 612, left: 86, fontFamily: BRUSH, fontSize: 100, color: INK }}>
                {DATA.subject.name}
              </div>
              <div style={{ position: "absolute", top: 726, left: 84, fontFamily: SERIF, fontWeight: 700, fontSize: 116, color: INK }}>
                {seg?.rocket
                  ? lt < 1.2
                    ? Math.round(lastCloseDisp)
                    : lt < 3.6
                      ? Math.round(26 + (lt - 1.2) * 380)
                      : "∞"
                  : Math.round(lastCloseDisp)}
              </div>
              <div style={{ position: "absolute", top: 664, right: 86, fontFamily: SERIF, fontSize: 36, color: GRAY }}>
                {DATA.subject.birth_year + Math.floor(BUILT.candles[lastCi].age) - 1}年 · {Math.floor(BUILT.candles[lastCi].age)}岁
              </div>
              {showDelist && (
                <div style={{ position: "absolute", top: 722, right: 86, fontFamily: SERIF, fontSize: 33, color: GRAY }}>
                  退市
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 大标题交叉淡入 */}
      {si >= 0 && lt >= 0.55 && headline(si, 1, 0)}
      {si >= 0 && lt < 0.55 && headline(si, lt / 0.55, 7 * (1 - lt / 0.55))}
      {si > 0 && lt < 0.55 && headline(si - 1, 1 - lt / 0.55, 7 * (lt / 0.55))}

      {/* 退市印章 */}
      {stampOn > 0 &&
        seg &&
        (() => {
          const localFrame = (lt - (seg.dur - 1.4)) * fps;
          const s = spring({ frame: localFrame, fps, config: { damping: 14, stiffness: 200, mass: 0.6 } });
          const scale = 1.55 - 0.55 * s;
          return (
            <div
              style={{
                position: "absolute",
                left: 450,
                top: 1035,
                width: 300,
                height: 190,
                backgroundColor: "rgba(28,25,21,0.94)",
                borderRadius: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: BRUSH,
                fontSize: 104,
                color: "#F3EEE2",
                transform: `rotate(-5deg) scale(${scale})`,
                opacity: stampOn,
              }}
            >
              退市
            </div>
          );
        })()}

      {/* 底部诗句 */}
      {quoteOpacity > 0 && seg?.quote && (
        <div
          style={{
            position: "absolute",
            top: 1632,
            left: 0,
            width: 1080,
            height: 120,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: quoteOpacity,
          }}
        >
          <span
            style={{
              fontFamily: SANS,
              fontWeight: 700,
              fontSize: 52,
              color: "#FCFAF4",
              textShadow: "2px 3px 6px rgba(74,64,46,0.55)",
              whiteSpace: "nowrap",
            }}
          >
            {seg.quote}
          </span>
        </div>
      )}

      {/* 片头卡 */}
      {hookOpacity > 0 && (
        <div style={{ position: "absolute", inset: 0, opacity: hookOpacity }}>
          <div
            style={{
              position: "absolute",
              top: 700,
              width: 1080,
              textAlign: "center",
              fontFamily: BRUSH,
              fontSize: 170,
              color: INK,
            }}
          >
            {DATA.subject.name.split("").join(" ")}
          </div>
          <div
            style={{
              position: "absolute",
              top: 950,
              width: 1080,
              textAlign: "center",
              fontFamily: SERIF,
              fontWeight: 700,
              fontSize: 62,
              color: ACCENT,
            }}
          >
            {DATA.subject.title.split("").join(" ")}
          </div>
          <div
            style={{
              position: "absolute",
              top: 1064,
              width: 1080,
              textAlign: "center",
              fontFamily: SERIF,
              fontSize: 34,
              color: GRAY,
            }}
          >
            {DATA.subject.stock_label}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
