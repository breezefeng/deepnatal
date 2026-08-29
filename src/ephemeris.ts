/**
 * ─────────────────────────────────────────────────────────────
 *  确定性层：天文星历计算
 * ─────────────────────────────────────────────────────────────
 *
 *  这一层是整个产品的信任地基。用户为「算出来的东西」付费，
 *  不为「生成出来的东西」付费。
 *
 *  ── 设计原则：让它自己证明自己是对的 ────────────────────────
 *
 *  这个文件的主人不一定读得懂天文算法。所以正确性不靠「相信代码」，
 *  靠三道会自己报警的机制：
 *
 *   1. 【双实现交叉验算】行星经度同时用两个完全独立的库算：
 *      circular-natal-horoscope-js（主）与 astronomy-engine（校验）。
 *      实测吻合到 0.58 角分。两者分歧超阈值 → 抛错，不返回结果。
 *
 *   2. 【时区双算核对】UTC 时刻同时用两条路算：
 *      (a) 显式 IANA 时区 + Node ICU 历史规则（本文件 localToUtc）
 *      (b) 库内部按经纬度反查时区
 *      不一致 → 抛错。这道检查专门抓「出生地时区判断错」——
 *      算错一小时 = 上升星座整个错 = 信任地基崩塌。
 *
 *   3. 【高纬度显式降级】|纬度| > 66° 时 Placidus 宫位制退化失效。
 *      不静默给错结果，而是降级 Whole Sign 并在返回值里带上原因，
 *      供 UI 向用户说明。
 *
 *  ── 许可证（ADR-0001 已定稿）────────────────────────────────
 *
 *   circular-natal-horoscope-js  Unlicense（公有领域）✅
 *   astronomy-engine             MIT ✅
 *   tz-lookup                    CC0-1.0 ✅
 *
 *   ⚠️ 不要引入 `sweph` / `swisseph`。其 package.json 写
 *      `(AGPL-3.0-or-later OR LGPL-3.0-or-later)` 是误导 ——
 *      README 明确：LGPL 选项的前提是**先购买 Astrodienst 商业授权**。
 *      不买就只能按 AGPL 用，而 AGPL 覆盖网络服务，会要求开放全部源码。
 */

import lib from 'circular-natal-horoscope-js';
import * as AE from 'astronomy-engine';

const { Origin, Horoscope } = lib as unknown as {
  Origin: new (o: OriginArgs) => OriginInstance;
  Horoscope: new (o: Record<string, unknown>) => HoroscopeInstance;
};

interface OriginArgs {
  year: number;
  /** ⚠️ 0-based（0 = 一月）。库的陷阱之一，本文件统一在边界处转换 */
  month: number;
  date: number;
  hour: number;
  minute: number;
  latitude: number;
  longitude: number;
}

interface OriginInstance {
  /** ⚠️ moment 对象，不是 Date。取 JS Date 要 .toDate() */
  utcTime: { toDate(): Date };
  /** ⚠️ 是 moment-timezone 的 Zone 对象，不是字符串。取名字要 .name */
  timezone: { name?: string } | string;
  julianDate: number;
  localSiderealTime: number;
}

interface BodyPosition {
  Sign: { label: string; key: string };
  ChartPosition: { Ecliptic: { DecimalDegrees: number } };
  House?: { id: number };
  isRetrograde?: boolean;
}

interface HoroscopeInstance {
  Ascendant: BodyPosition;
  Midheaven: BodyPosition;
  CelestialBodies: Record<string, BodyPosition>;
  Houses: { ChartPosition: { StartPosition: { Ecliptic: { DecimalDegrees: number } } } }[];
}

// ─────────────────────────────────────────────────────────────

export interface BirthData {
  /** 本地出生日期 YYYY-MM-DD */
  date: string;
  /** 本地出生时间 HH:mm（24h）。未知时间走 calculateWithoutTime */
  time: string;
  /**
   * IANA 时区，如 'Asia/Shanghai'。
   * 必须由**出生地**推导，不能用浏览器时区 —— 用户在纽约填台北出生数据是常态。
   */
  timezone: string;
  latitude: number;
  longitude: number;
}

export interface PlanetPosition {
  planet: string;
  /** 黄道经度 0–360 */
  longitude: number;
  sign: string;
  /** 星座内度数 0–30 */
  degreeInSign: number;
  house: number;
  retrograde: boolean;
}

export type HouseSystem = 'placidus' | 'whole-sign';

export interface NatalChart {
  planets: PlanetPosition[];
  ascendant: { sign: string; degreeInSign: number; longitude: number };
  midheaven: { sign: string; degreeInSign: number; longitude: number };
  houseCusps: number[];
  /** 计算所用的 UTC 时刻，便于排查时区问题 */
  utc: string;
  /** 实际使用的宫位制。可能因高纬度被降级 */
  houseSystem: HouseSystem;
  /** 非 null 表示发生了降级，UI 必须向用户说明原因 */
  degradedReason: string | null;
  /**
   * true 表示上升点在数学上不稳定（极区）。
   * 此时上升点可能与其他占星工具相差整整 180°，且这不是任何一方「算错」——
   * 是「上升点」这个概念在极区退化。UI 必须显示提示。
   */
  ascendantUnstable: boolean;
  /** 双实现交叉验算的最大偏差（角分）。用于监控算法漂移 */
  crossCheckMaxArcmin: number;
  /**
   * 非 null 表示所填时区与出生地坐标推导的时区不同，但属于已知合法歧义
   * （如新疆的北京时间 / 新疆时间）。UI 必须提示用户确认。
   */
  tzAmbiguity: { used: string; alternative: string; diffMinutes: number } | null;
}

/** Placidus 在极区退化的纬度阈值 */
const PLACIDUS_LAT_LIMIT = 66;
/** 双实现允许的最大分歧（角分）。实测正常值 < 1 */
const CROSS_CHECK_TOLERANCE_ARCMIN = 15;

/**
 * 已知的合法时区歧义对。
 *
 * 时区守卫的原则是「声明时区」与「坐标反查时区」不一致就拒算，
 * 因为算错一小时上升星座就错。但有些地区确实存在两个都成立的时区：
 *
 *  · 新疆：官方全国统一北京时间 UTC+8（出生证明、户口本用这个），
 *    IANA 另有 Asia/Urumqi UTC+6，当地民间说的「新疆时间」是它。
 *    两者差 2 小时，我们无法替用户判断他填的是哪个。
 *
 * 对这类已知歧义，守卫放行，但把事实记录在 tzAmbiguity 里，
 * 由 UI 提示用户确认 —— 放行不等于隐瞒。
 */
const KNOWN_TZ_AMBIGUITY: [string, string][] = [
  ['Asia/Shanghai', 'Asia/Urumqi'],
  ['Asia/Shanghai', 'Asia/Kashgar'],
];

function isKnownAmbiguity(a: string, b: string): boolean {
  return KNOWN_TZ_AMBIGUITY.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x),
  );
}

const PLANET_TO_AE: Record<string, string> = {
  sun: 'Sun', moon: 'Moon', mercury: 'Mercury', venus: 'Venus', mars: 'Mars',
  jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune', pluto: 'Pluto',
};

const SIGN_ORDER = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
] as const;

// ─────────────────────────────────────────────────────────────
//  时区：本地时间 → UTC，走 Node ICU 的完整历史规则
// ─────────────────────────────────────────────────────────────

/**
 * 查某个 UTC 时刻在某时区的偏移（分钟）。
 * 用 Intl 而不是手写规则表 —— Node 内置 ICU 带完整 tzdata 历史数据。
 * 已验证覆盖：中国 1986–1991 夏令时、日本 1950 GHQ 夏令时、台湾 1979 夏令时。
 */
function tzOffsetMinutes(utc: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utc);
  const p = new Map(parts.map((x) => [x.type, x.value]));
  const n = (k: Intl.DateTimeFormatPartTypes): number => {
    const v = p.get(k);
    if (v === undefined) throw new Error(`Intl 未回傳 ${k}（時區 ${timeZone} 可能無效）`);
    return Number(v);
  };
  const asIfUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return (asIfUtc - utc.getTime()) / 60000;
}

/** 解析 YYYY-MM-DD / HH:mm，缺任何一段就抛错（不静默补 0） */
function parseLocal(dateISO: string, timeHHmm: string): {
  y: number; mo: number; d: number; hh: number; mm: number;
} {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(timeHHmm);
  if (!dm || !tm) {
    throw new Error(`出生日期/時間格式非法: date=${dateISO} time=${timeHHmm}（應為 YYYY-MM-DD / HH:mm）`);
  }
  return {
    y: Number(dm[1]), mo: Number(dm[2]), d: Number(dm[3]),
    hh: Number(tm[1]), mm: Number(tm[2]),
  };
}

/**
 * 本地挂钟时间 + IANA 时区 → UTC。
 *
 * 偏移本身依赖时刻（夏令时），所以要迭代两次收敛。
 * 夏令时切换当天存在「不存在的时间」与「重复的时间」，
 * 这里采取的策略是取第一个匹配解，并在无解时抛错而不是猜。
 */
export function localToUtc(
  dateISO: string, timeHHmm: string, timeZone: string,
): { utc: Date; offsetMinutes: number } {
  const { y, mo, d, hh, mm } = parseLocal(dateISO, timeHHmm);
  const naiveUtc = Date.UTC(y, mo - 1, d, hh, mm);
  let offset = tzOffsetMinutes(new Date(naiveUtc), timeZone);
  for (let i = 0; i < 3; i++) {
    const candidate = new Date(naiveUtc - offset * 60000);
    const recomputed = tzOffsetMinutes(candidate, timeZone);
    if (recomputed === offset) {
      return { utc: candidate, offsetMinutes: offset };
    }
    offset = recomputed;
  }
  throw new Error(
    `時區換算無法確定：${dateISO} ${timeHHmm} @ ${timeZone}\n` +
      `這個時間落在夏令時間切換的那一兩個小時內，可能不存在或出現兩次。\n` +
      `請確認是切換前還是切換後的時間。`,
  );
}

// ─────────────────────────────────────────────────────────────
//  独立校验：astronomy-engine 算地心当日真黄道经度
// ─────────────────────────────────────────────────────────────

function independentEclipticLongitude(aeBody: string, utc: Date): number {
  // GeoVector = 地心向量（含光行差）；Rotation_EQJ_ECT = J2000 赤道 → 当日真黄道
  const gv = AE.GeoVector(aeBody as AE.Body, utc, true);
  const ecl = AE.RotateVector(AE.Rotation_EQJ_ECT(utc), gv);
  const sphere = AE.SphereFromVector(ecl);
  return (sphere.lon + 360) % 360;
}

function angularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function signFromLongitude(lon: number): { sign: string; degreeInSign: number } {
  const norm = ((lon % 360) + 360) % 360;
  const idx = Math.min(11, Math.floor(norm / 30));
  return { sign: SIGN_ORDER[idx] ?? 'aries', degreeInSign: norm - idx * 30 };
}

// ─────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────

export function calculateNatalChart(birth: BirthData): NatalChart {
  const { y, mo, d, hh, mm } = parseLocal(birth.date, birth.time);

  // ── 门槛 1：自己算 UTC（显式时区 + ICU 历史规则）─────────────
  const { utc } = localToUtc(birth.date, birth.time, birth.timezone);

  // ── 高纬度：Placidus 退化 → 显式降级，不静默给错结果 ─────────
  const tooFarNorth = Math.abs(birth.latitude) > PLACIDUS_LAT_LIMIT;
  const houseSystem: HouseSystem = tooFarNorth ? 'whole-sign' : 'placidus';
  const degradedReason = tooFarNorth
    ? `出生地緯度 ${birth.latitude.toFixed(2)}° 超過 ${PLACIDUS_LAT_LIMIT}°，位於極圈內。\n` +
      `① 宮位制：Placidus 在極區會失效，已自動改用整宮制（Whole Sign）。\n` +
      `② 上升點：在極圈內，黃道可能幾乎與地平面相切，「正在升起的黃道點」` +
      `會在臨界處翻轉 —— 上升點在數學上不穩定，不同占星工具可能給出相差 180° 的結果。\n` +
      `   這不是誰算錯了，而是這個概念本身在極區失去意義。請把結果當作參考而非精確值。`
    : null;

  /**
   * 构造 Origin。
   *
   * ⚠️ 陷阱：Origin 会自己按经纬度反查时区做本地→UTC 换算，
   *    不接受外部指定时区。当它反查出的时区与用户声明的不同时
   *    （例如新疆：声明北京时间，它反查成 Asia/Urumqi），
   *    它算出的 UTC 会和我们的差 2 小时，而我们的交叉验算用的是
   *    我们自己的 UTC —— 结果是月亮差 70+ 角分，验算失败。
   *
   *    所以这里允许传入一个毫秒偏移量，把喂给 Origin 的挂钟时间
   *    平移，使它自己的换算结果正好落在我们要的 UTC 上。
   */
  const makeOrigin = (shiftMs: number) => {
    const wall = new Date(Date.UTC(y, mo - 1, d, hh, mm) + shiftMs);
    return new Origin({
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth(), // ⚠️ 库是 0-based，getUTCMonth 正好也是
      date: wall.getUTCDate(),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      latitude: birth.latitude,
      longitude: birth.longitude,
    });
  };

  let origin = makeOrigin(0);

  // ── 门槛 2：时区双算核对 ────────────────────────────────────
  const libUtc = origin.utcTime.toDate();
  const driftMinutes = Math.abs(libUtc.getTime() - utc.getTime()) / 60000;
  const derivedTz =
    typeof origin.timezone === 'string' ? origin.timezone : (origin.timezone?.name ?? '');

  // 已知合法歧义：放行，但必须把库拉回到我们的 UTC，否则盘本身就是错的
  let tzAmbiguity: NatalChart['tzAmbiguity'] = null;
  if (driftMinutes > 1 && isKnownAmbiguity(birth.timezone, derivedTz)) {
    tzAmbiguity = {
      used: birth.timezone,
      alternative: derivedTz,
      diffMinutes: driftMinutes,
    };
    // 平移喂给 Origin 的挂钟时间，让它自己的换算落在我们的 UTC 上
    origin = makeOrigin(utc.getTime() - libUtc.getTime());
    const check = Math.abs(origin.utcTime.toDate().getTime() - utc.getTime()) / 60000;
    if (check > 1) {
      // 平移后仍对不上，说明跨了夏令时边界之类的复杂情况 —— 不猜，直接拒算
      throw new Error(
        `這個出生地有兩種時間標準，我們無法確定該用哪一個。\n` +
          `  ${birth.timezone} 與 ${derivedTz} 相差 ${driftMinutes} 分鐘。\n` +
          `請聯絡我們並附上出生地與時間，我們手動確認。`,
      );
    }
  } else if (driftMinutes > 1) {
    throw new Error(
      `出生地與時區不一致，為避免算錯，這次不輸出結果。\n` +
        `  你選的時區 ${birth.timezone} → UTC ${utc.toISOString()}\n` +
        `  由出生地座標反查 ${derivedTz || '未知'} → UTC ${libUtc.toISOString()}\n` +
        `  兩者相差 ${driftMinutes} 分鐘。\n` +
        `時間差一小時，上升星座就可能整個不同。請確認出生地是否正確。`,
    );
  }

  const horoscope = new Horoscope({
    origin,
    houseSystem,
    zodiac: 'tropical',
    aspectPoints: ['bodies'],
    language: 'en',
  });

  // ── 门槛 3：双实现交叉验算 ──────────────────────────────────
  let maxArcmin = 0;
  let worst = '';
  const planets: PlanetPosition[] = [];

  for (const [key, aeName] of Object.entries(PLANET_TO_AE)) {
    const body = horoscope.CelestialBodies[key];
    if (!body) throw new Error(`星曆庫未回傳 ${key} 的位置，請回報給我們。`);

    const lon = body.ChartPosition.Ecliptic.DecimalDegrees;
    const independent = independentEclipticLongitude(aeName, utc);
    const arcmin = angularDiff(lon, independent) * 60;
    if (arcmin > maxArcmin) { maxArcmin = arcmin; worst = key; }

    const { sign, degreeInSign } = signFromLongitude(lon);
    planets.push({
      planet: key,
      longitude: lon,
      sign,
      degreeInSign,
      house: body.House?.id ?? 0,
      retrograde: Boolean(body.isRetrograde),
    });
  }

  if (maxArcmin > CROSS_CHECK_TOLERANCE_ARCMIN) {
    throw new Error(
      `內部驗算未通過，為避免給出錯誤結果，這次不輸出。\n` +
        `  ${worst} 的兩套演算法差異 ${maxArcmin.toFixed(2)} 角分（容許值 ${CROSS_CHECK_TOLERANCE_ARCMIN}）。\n` +
        `  這是我們這邊的問題，不是你的資料有誤。請稍後再試或回報給我們。`,
    );
  }

  const ascLon = horoscope.Ascendant.ChartPosition.Ecliptic.DecimalDegrees;
  const mcLon = horoscope.Midheaven.ChartPosition.Ecliptic.DecimalDegrees;

  return {
    planets,
    ascendant: { ...signFromLongitude(ascLon), longitude: ascLon },
    midheaven: { ...signFromLongitude(mcLon), longitude: mcLon },
    houseCusps: horoscope.Houses.map(
      (h) => h.ChartPosition.StartPosition.Ecliptic.DecimalDegrees,
    ),
    utc: utc.toISOString(),
    houseSystem,
    degradedReason,
    ascendantUnstable: tooFarNorth,
    crossCheckMaxArcmin: +maxArcmin.toFixed(3),
    tzAmbiguity,
  };
}

// ─────────────────────────────────────────────────────────────
//  出生时间未知的降级路径
// ─────────────────────────────────────────────────────────────

export interface PartialChart {
  planets: PlanetPosition[];
  utc: string;
  /** 明确告知用户缺了什么，以及为什么 */
  unavailable: { field: string; reason: string }[];
  /** 月亮在这一天内的移动范围（度）。超过一个星座宽度时月亮星座也不确定 */
  moonUncertaintyDegrees: number;
  moonSignAmbiguous: boolean;
}

/**
 * 出生时间未知时的降级路径。
 *
 * 不能假装算得出上升 —— 那会毁掉信任。正确做法是明确告知
 * 「需要出生时间才能算上升与宫位」，只给对时间不敏感的结果，
 * 并把「回去问家人具体时间」变成一个回访钩子。
 *
 * ⚠️ 一个容易被忽略的点：月亮一天移动约 12–15°，
 *    有近一半的日期，月亮会在当天跨星座。这种情况必须告诉用户
 *    「你的月亮星座取决于出生时间」，而不是给一个可能错的答案。
 */
export function calculateWithoutTime(birth: Omit<BirthData, 'time'>): PartialChart {
  // 取当地正午作为代表时刻：让最大误差落在 ±12 小时内，而不是 ±24
  const { utc } = localToUtc(birth.date, '12:00', birth.timezone);

  const planets: PlanetPosition[] = [];
  for (const [key, aeName] of Object.entries(PLANET_TO_AE)) {
    const lon = independentEclipticLongitude(aeName, utc);
    planets.push({
      planet: key,
      longitude: lon,
      ...signFromLongitude(lon),
      house: 0, // 无出生时间 → 无宫位
      retrograde: false,
    });
  }

  // 月亮当天移动范围：比较当地 00:00 与 23:59
  const startUtc = localToUtc(birth.date, '00:00', birth.timezone).utc;
  const endUtc = localToUtc(birth.date, '23:59', birth.timezone).utc;
  const moonStart = independentEclipticLongitude('Moon', startUtc);
  const moonEnd = independentEclipticLongitude('Moon', endUtc);
  const moonSpan = angularDiff(moonStart, moonEnd);
  const ambiguous =
    signFromLongitude(moonStart).sign !== signFromLongitude(moonEnd).sign;

  return {
    planets,
    utc: utc.toISOString(),
    unavailable: [
      { field: 'ascendant', reason: '上升星座取決於出生的具體時刻，沒有出生時間無法計算' },
      { field: 'midheaven', reason: '同上' },
      { field: 'houses', reason: '宮位分割依賴上升點，沒有出生時間無法計算' },
      ...(ambiguous
        ? [{
            field: 'moonSign',
            reason: `你出生那天月亮從${signFromLongitude(moonStart).sign}移動到${signFromLongitude(moonEnd).sign}，` +
                    `月亮星座取決於出生時間 —— 這個結果只是當地正午的位置，可能不準`,
          }]
        : []),
    ],
    moonUncertaintyDegrees: +moonSpan.toFixed(2),
    moonSignAmbiguous: ambiguous,
  };
}
