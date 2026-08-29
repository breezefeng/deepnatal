/**
 * ─────────────────────────────────────────────────────────────
 *  独立验算：用第三条路径复算上升点
 * ─────────────────────────────────────────────────────────────
 *
 *  为什么需要这个：
 *
 *  上升星座是本产品最高风险的数字。它错一个星座，用户立刻能察觉，
 *  「确定性计算做信任锚」的整个产品假设当场崩塌。
 *
 *  而上升点的计算涉及实现约定（黄道倾角用平黄道还是真黄道、
 *  是否含光行差、恒星时算法版本），不同库有可能都「看起来对」却互相不同。
 *
 *  所以这里用**纯几何**再算一遍，完全不依赖任何占星库：
 *  上升点 = 黄道与地平圈在东方的交点。
 *  数值扫描 + 二分求根，只用 astronomy-engine 的坐标系旋转矩阵。
 *
 *  实测与 circular-natal-horoscope-js 吻合 0.5 角分以内。
 *
 *  ⚠️ 坐标系陷阱（踩过）：astronomy-engine 的地平坐标系是
 *     +x = 北, +y = 西, +z = 天顶。
 *     所以「正东」的方位角是 270°，不是 90°。
 *     用错会得到下降点（正好差 180°，且度数完全一样，极易误判为「对了」）。
 */

import * as AE from 'astronomy-engine';

/**
 * 纯几何法求上升点黄经。
 *
 * 判据用的是上升点的**定义**而不是方位角：
 *   上升点 = 此刻位于地平线上、且因周日运动正在**升起**的那个黄道点。
 * 「正在升起」= 该黄道点的地平高度对时间的导数为正。
 *
 * 为什么不用方位角判「东方」：在 |纬度| > 66° 的极区，黄道可能几乎与地平面
 * 平行，两个交点会落在同一侧，方位角判据会选错，且错的结果恰好差 180°、
 * 度数完全一样 —— 极易被误认为「算对了」。（这个坑踩过。）
 *
 * @returns 黄经 0–360，求不到时返回 null
 */
export function ascendantByGeometry(
  utc: Date, latitude: number, longitude: number,
): number | null {
  const observer = new AE.Observer(latitude, longitude, 0);

  /** 某黄经处（黄纬 0）的黄道点在给定时刻的地平高度 */
  const altitudeAt = (eclipticLon: number, at: Date): number => {
    const rad = (eclipticLon * Math.PI) / 180;
    // ⚠️ AE.Vector 的第 4 个参数要 AstroTime，不是 Date
    const onEcliptic = new AE.Vector(Math.cos(rad), Math.sin(rad), 0, AE.MakeTime(at));
    const inHorizon = AE.RotateVector(
      AE.Rotation_EQD_HOR(at, observer),
      AE.RotateVector(AE.Rotation_ECT_EQD(at), onEcliptic),
    );
    return AE.SphereFromVector(inHorizon).lat;
  };

  const alt = (lon: number) => altitudeAt(lon, utc);

  // 扫一圈找高度穿零的黄经（恰有两个：上升点与下降点）
  const crossings: number[] = [];
  let prev = alt(0);
  for (let deg = 1; deg <= 360; deg++) {
    const cur = alt(deg % 360);
    if (prev < 0 !== cur < 0) {
      let lo = deg - 1;
      let hi = deg;
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (alt(mid % 360) < 0 === prev < 0) lo = mid;
        else hi = mid;
      }
      crossings.push(((lo + hi) / 2) % 360);
    }
    prev = cur;
  }
  if (crossings.length === 0) return null;

  // 挑「正在升起」的那个：60 秒后高度变高
  const later = new Date(utc.getTime() + 60_000);
  let best: number | null = null;
  let bestRate = -Infinity;
  for (const lon of crossings) {
    const rate = altitudeAt(lon, later) - altitudeAt(lon, utc);
    if (rate > bestRate) {
      bestRate = rate;
      best = lon;
    }
  }
  return bestRate > 0 ? best : null;
}

/** 两个黄经的角距（0–180） */
export function angularDiffDegrees(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
