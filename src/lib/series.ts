// 人生K线：脚本类型、带种子的 K 线序列生成、轴域与标注排版。
// 算法与 Python 原型（content.py）一致：关键点之间用对数空间布朗桥填充行情噪声。

export interface Segment {
  id: string;
  dur: number;
  kp: [number, number];
  candles: number;
  vol: number;
  shape: number;
  headline: [string, number][][];
  quote?: string | null;
  stamp?: boolean;
  rocket?: boolean;
}

export interface ScriptData {
  subject: {
    name: string;
    title: string;
    birth_year: number;
    stock_label: string;
    series: string;
  };
  hook_dur: number;
  seed: number;
  bpm?: number;
  template?: string;
  bgm_tags?: string;
  voice?: { intro?: string; outro?: string; style?: string };
  keypoints: [number, number, string | null][];
  segments: Segment[];
  bgm?: string;
}

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  seg: number;
  tag: string | null;
  anno: string | null;
  age: number;
  appear: number; // 秒
  grow: number;
}

export const PX0 = 150;
export const PX1 = 1002;
export const PY0 = 900;
export const PY1 = 1412;
export const VY0 = 1446;
export const VY1 = 1514;

// mulberry32：小而稳的种子随机数（跨平台一致）
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandn(rand: () => number) {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

function bridge(
  randn: () => number,
  a: number,
  b: number,
  n: number,
  vol: number,
  shape: number,
): number[] {
  if (n <= 0) return [];
  const la = Math.log(a);
  const lb = Math.log(b);
  const steps: number[] = [];
  for (let i = 0; i < n; i++) steps.push(randn() * vol);
  const sumSteps = steps.reduce((x, y) => x + y, 0);
  const out: number[] = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    cum += steps[i];
    const mean = la + (lb - la) * Math.pow(t, shape);
    const br = cum - t * sumSteps;
    out.push(Math.exp(mean + br * 0.55));
  }
  out[n - 1] = b;
  return out;
}

export interface BuiltSeries {
  candles: Candle[];
  segStarts: number[];
  cum: number[]; // 每段结束时累计蜡烛数
  maxVol: number;
  totalSec: number;
}

export function buildSeries(data: ScriptData): BuiltSeries {
  const rand = mulberry32(data.seed);
  const randn = makeRandn(rand);
  const KP = data.keypoints;
  const candles: Candle[] = [];
  const segStarts: number[] = [];
  const cum: number[] = [];
  let t = data.hook_dur;
  let prevClose = KP[0][1];

  data.segments.forEach((seg, si) => {
    segStarts.push(t);
    t += seg.dur;
    const [k0, k1] = seg.kp;
    const ids: number[] = [];
    if (k0 !== k1 && seg.candles > 0) {
      const span = KP[k1][0] - KP[k0][0];
      const raw: number[] = [];
      for (let k = k0; k < k1; k++) {
        raw.push(Math.max(2, Math.round((seg.candles * (KP[k + 1][0] - KP[k][0])) / span)));
      }
      raw[raw.length - 1] += seg.candles - raw.reduce((x, y) => x + y, 0);
      for (let li = 0; li < raw.length; li++) {
        const k = k0 + li;
        const [aAge, aVal] = KP[k];
        const [bAge, bVal, bAnno] = KP[k + 1];
        const n = raw[li];
        const closes = bridge(randn, aVal, bVal, n, seg.vol, seg.shape);
        closes.forEach((c, j) => {
          const o = prevClose;
          const age = aAge + ((bAge - aAge) * (j + 1)) / n;
          const hi = Math.max(o, c) * (1 + Math.abs(randn() * seg.vol * 0.45));
          const lo = Math.min(o, c) * (1 - Math.abs(randn() * seg.vol * 0.45));
          const chg = (c - o) / o;
          const tag = chg >= 0.17 ? "涨停" : chg <= -0.17 ? "跌停" : null;
          const vol = Math.max(6, 26 + Math.abs(chg) * 620 + randn() * 7);
          candles.push({
            o, h: hi, l: lo, c, vol,
            seg: si, tag,
            anno: j === n - 1 ? bAnno : null,
            age,
            appear: 0,
            grow: 0.3,
          });
          ids.push(candles.length - 1);
          prevClose = c;
        });
      }
    }
    // 蜡烛出现时刻吸附到半拍网格，让跳动和音乐拍点对齐（bpm 缺省 120，半拍 0.25 秒）
    const grid = 30 / (data.bpm ?? 120);
    ids.forEach((ci, j) => {
      const raw = segStarts[si] + 0.25 + (j * (seg.dur * 0.7)) / Math.max(ids.length, 1);
      candles[ci].appear = Math.round(raw / grid) * grid;
    });
    cum.push(candles.length);
  });

  return {
    candles,
    segStarts,
    cum,
    maxVol: Math.max(...candles.map((c) => c.vol)),
    totalSec: t,
  };
}

export function totalFrames(data: ScriptData, fps = 30): number {
  const total = data.hook_dur + data.segments.reduce((s, x) => s + x.dur, 0);
  return Math.round(total * fps) + 6;
}

const STEPS = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

export function niceAxis(lo: number, hi: number): [number, number, number] {
  const span = Math.max(hi - lo, 1e-6);
  const raw = span / 3.2;
  const step = STEPS.find((s) => s >= raw) ?? 100;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step, step];
}

export function axisTarget(candles: Candle[], upto: number): [number, number, number] {
  const sub = candles.slice(0, Math.max(upto, 1));
  const lo = Math.min(...sub.map((c) => c.l));
  const hi = Math.max(...sub.map((c) => c.h));
  const pad = (hi - lo) * 0.14 + 0.4;
  let lo2 = lo - pad;
  if (lo >= 0) lo2 = Math.max(0, lo2);
  return niceAxis(lo2, hi + pad);
}

export function domainTarget(data: ScriptData, built: BuiltSeries, si: number): number {
  if (data.segments[si].rocket) return built.cum[si] + 30;
  return Math.max(built.cum[si], 24);
}

export interface AnnoPlace {
  side: 1 | -1;
  level: number;
}

// 标注排版：最终帧坐标下贪心避让，返回 candle 索引到位置的映射
export function annoLayout(candles: Candle[]): Map<number, AnnoPlace> {
  const loAll = Math.min(...candles.map((c) => c.l));
  const hiAll = Math.max(...candles.map((c) => c.h));
  const [alo, ahi] = niceAxis(loAll - 2, hiAll + 3);
  const dom = candles.length + 30;
  const slot = (PX1 - PX0) / dom;
  const X = (ci: number) => PX0 + slot * (ci + 0.5);
  const Y = (v: number) => PY1 - ((v - alo) / (ahi - alo)) * (PY1 - PY0);
  const placed: [number, number, number, number][] = [];
  const out = new Map<number, AnnoPlace>();
  candles.forEach((c, ci) => {
    if (!c.anno) return;
    const tw = c.anno.length * 31;
    const cx = X(ci);
    const preferBelow = c.h > alo + (ahi - alo) * 0.8;
    const sides: (1 | -1)[] = preferBelow ? [-1, 1] : [1, -1];
    let done = false;
    for (const side of sides) {
      for (let level = 0; level < 3; level++) {
        let y0: number;
        let y1: number;
        if (side === 1) {
          y1 = Y(c.h) - 14 - level * 44;
          y0 = y1 - 40;
        } else {
          y0 = Y(c.l) + 14 + level * 44;
          y1 = y0 + 40;
        }
        const x0 = cx - tw / 2;
        const x1 = cx + tw / 2;
        const hit = placed.some(
          ([px0, px1, py0, py1]) => !(x1 < px0 - 8 || x0 > px1 + 8 || y1 < py0 - 6 || y0 > py1 + 6),
        );
        if (!hit) {
          placed.push([x0, x1, y0, y1]);
          out.set(ci, { side, level });
          done = true;
          break;
        }
      }
      if (done) break;
    }
    if (!done) out.set(ci, { side: sides[0], level: 2 });
  });
  return out;
}

export function fmtTick(v: number, step: number): string {
  if (step < 1 || step % 1 !== 0) {
    return v % 1 ? v.toFixed(1).replace(/0$/, "") : v.toFixed(0);
  }
  return v.toFixed(0);
}

export const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
