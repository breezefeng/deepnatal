/**
 * 回归测试基准盘 —— Week 1 的验收门槛。
 *
 *   npm run test:ephemeris
 *
 * ── 这版的做法和 v0.1 计划的不一样，说明一下为什么 ──────────────
 *
 * v0.1 计划是：从 astro.com 抄 20 组星盘的正确答案，硬编码进来对比。
 * 问题是：手抄 20 组 × 十几个数字 = 上百个数字，抄错的概率比代码写错还高，
 * 而且抄完之后这些数字就固化了，改算法时你分不清是代码错了还是当年抄错了。
 *
 * 这版改成三层验证，每层都是**自动算出来的**，不是手抄的：
 *
 *  ① 时区层：Node ICU 历史 tzdata（覆盖中国 1986–91、日本 1950 GHQ 等）
 *  ② 行星层：两个独立库交叉验算（circular-natal-horoscope-js × astronomy-engine）
 *  ③ 上升层：纯几何第三条路径（黄道 × 东地平线交点）
 *
 * 外部权威源核对只做**少量**、但必须做 —— 因为上面三层共享同一套约定假设
 * （热带黄道、视地心、当日真黄道），万一约定本身错了三层会一起错。
 * EXTERNAL_CHECKS 就是干这个的，值来自实际访问 astro-seek 抓取，非人工估算。
 *
 * ── 边界挑选原则：专挑会出错的，不要挑好算的 ──────────────────
 */

import type { BirthData } from './ephemeris.ts';

export interface Fixture {
  name: string;
  /** 这条专门测什么边界 */
  covers: string;
  birth: BirthData;
  /** 预期使用的宫位制（高纬度应降级） */
  expectHouseSystem?: 'placidus' | 'whole-sign';
  /** 预期抛错（比如夏令时空洞时刻） */
  expectThrows?: boolean;
}

export const FIXTURES: Fixture[] = [
  // ── 东亚夏令时历史（国内工具最常算错）───────────────────────
  {
    name: 'china-dst-1988-summer',
    covers: '中国 1986–1991 夏令时期间出生（+9 而非 +8）',
    birth: { date: '1988-07-15', time: '14:30', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 121.47 },
  },
  {
    name: 'china-1988-winter',
    covers: '同年冬季无夏令时（+8）—— 与上一条对照',
    birth: { date: '1988-01-15', time: '14:30', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 121.47 },
  },
  {
    name: 'china-1992-after-abolition',
    covers: '1992 年废除夏令时之后（+8）',
    birth: { date: '1992-07-15', time: '14:30', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 121.47 },
  },
  {
    name: 'taiwan-dst-1979',
    covers: '台湾 1979 夏令时（+9）—— P0 市场，必须对',
    birth: { date: '1979-07-15', time: '12:00', timezone: 'Asia/Taipei', latitude: 25.03, longitude: 121.56 },
  },
  {
    name: 'taiwan-modern',
    covers: '台湾现代（+8）—— P0 市场主流情况',
    birth: { date: '2000-03-21', time: '08:00', timezone: 'Asia/Taipei', latitude: 25.03, longitude: 121.56 },
  },
  {
    name: 'japan-ghq-dst-1950',
    covers: '日本 1948–1951 GHQ 夏令时（+10）—— P1 市场',
    birth: { date: '1950-07-15', time: '12:00', timezone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 },
  },
  {
    name: 'japan-modern',
    covers: '日本现代（+9）',
    birth: { date: '1995-11-03', time: '06:20', timezone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 },
  },

  // ── 1970 年前 / tzdb 早期规则 ────────────────────────────────
  {
    name: 'pre-1970-new-york',
    covers: 'tzdb 早期规则，1970 年前',
    birth: { date: '1962-03-21', time: '23:45', timezone: 'America/New_York', latitude: 40.71, longitude: -74.01 },
  },
  {
    name: 'pre-1970-london',
    covers: '英国 1968–1971 全年 BST 实验期',
    birth: { date: '1969-06-15', time: '09:00', timezone: 'Europe/London', latitude: 51.51, longitude: -0.13 },
  },

  // ── 高纬度：Placidus 退化 ───────────────────────────────────
  {
    name: 'high-latitude-tromso',
    covers: '69.65°N —— Placidus 退化，必须降级 Whole Sign',
    birth: { date: '1990-01-10', time: '03:00', timezone: 'Europe/Oslo', latitude: 69.65, longitude: 18.96 },
    expectHouseSystem: 'whole-sign',
  },
  {
    name: 'just-below-latitude-limit',
    covers: '65.9°N —— 刚好在阈值下，应仍用 Placidus（防止阈值写反）',
    birth: { date: '1990-01-10', time: '03:00', timezone: 'Europe/Helsinki', latitude: 65.9, longitude: 25.47 },
    expectHouseSystem: 'placidus',
  },
  {
    name: 'southern-high-latitude',
    covers: '南半球高纬 -68° —— 阈值必须对绝对值生效',
    // ⚠️ 时区必须与 tz-lookup 对这个坐标的判定一致。这个坐标（南极半岛）
    // tz-lookup 归为 America/Argentina/Ushuaia（-03），而 Antarctica/Palmer 是 -04 ——
    // 写成后者会被时区守卫拦住（而且守卫是对的）。
    birth: { date: '1985-06-21', time: '12:00', timezone: 'America/Argentina/Ushuaia', latitude: -68.0, longitude: -65.0 },
    expectHouseSystem: 'whole-sign',
  },

  // ── 守卫自身的测试：时区与出生地不匹配时必须拒算 ────────
  {
    name: 'guard-timezone-mismatch',
    covers:
      '★ 测守卫本身：声明台北时区但坐标在纽约。这类错配在真实产品里' +
      '很常见（用户在国外填国内出生数据，前端默认取了浏览器时区）。' +
      '必须报错，不能静默给出错的上升。',
    birth: { date: '1990-05-05', time: '10:00', timezone: 'Asia/Taipei', latitude: 40.71, longitude: -74.01 },
    expectThrows: true,
  },

  // ── UTC 边界 / 跨日 ─────────────────────────────────────────
  {
    name: 'local-midnight-crossing-utc-back',
    covers: '当地 00:30 —— UTC 日期回退一天',
    birth: { date: '2001-05-10', time: '00:30', timezone: 'Asia/Taipei', latitude: 25.03, longitude: 121.56 },
  },
  {
    name: 'local-late-night-crossing-utc-forward',
    covers: '当地 23:50 —— UTC 日期前进一天',
    birth: { date: '2001-05-10', time: '23:50', timezone: 'America/Los_Angeles', latitude: 34.05, longitude: -118.24 },
  },
  {
    name: 'dateline-kiritimati',
    covers: 'UTC+14 —— 全球最东时区',
    birth: { date: '2010-01-01', time: '02:00', timezone: 'Pacific/Kiritimati', latitude: 1.87, longitude: -157.4 },
  },
  {
    name: 'half-hour-offset-india',
    covers: 'UTC+5:30 半小时偏移',
    birth: { date: '1987-09-09', time: '17:45', timezone: 'Asia/Kolkata', latitude: 28.61, longitude: 77.21 },
  },
  {
    name: 'quarter-hour-offset-nepal',
    covers: 'UTC+5:45 —— 15 分钟粒度偏移，最容易被硬编码逻辑漏掉',
    birth: { date: '1993-04-12', time: '10:15', timezone: 'Asia/Kathmandu', latitude: 27.72, longitude: 85.32 },
  },

  // ── 星座交界 / 逆行 ─────────────────────────────────────────
  {
    name: 'sun-at-sign-boundary',
    covers: '春分点附近出生 —— 太阳在白羊 0° 交界，度数算错就跨星座',
    birth: { date: '2000-03-20', time: '07:35', timezone: 'UTC', latitude: 0, longitude: 0 },
  },
  {
    name: 'mercury-retrograde',
    covers: '水星逆行期间 —— 检验 retrograde 标记',
    birth: { date: '2020-02-20', time: '12:00', timezone: 'Europe/Berlin', latitude: 52.52, longitude: 13.41 },
  },
  {
    name: 'southern-hemisphere-sydney',
    covers: '南半球 + 南半球夏令时',
    birth: { date: '1996-12-25', time: '15:30', timezone: 'Australia/Sydney', latitude: -33.87, longitude: 151.21 },
  },
];

export const FIXTURE_TARGET = 20;

/**
 * 外部权威源核对。
 *
 * 值来自实际访问 astro-seek.com 抓取（非人工估算、非模型记忆）。
 * 作用：捕捉「本项目三层验证共享的约定假设」本身出错的情况。
 *
 * 只记星座（不记度分）—— 星座是用户唯一能察觉的粒度，
 * 而度分级差异记进来只会因为对方站点算法微调而产生假警报。
 */
export interface ExternalCheck {
  fixtureName: string;
  source: string;
  fetchedAt: string;
  signs: Record<string, string>;
}

export const EXTERNAL_CHECKS: ExternalCheck[] = [
  {
    fixtureName: 'china-dst-1988-summer',
    source: 'horoscopes.astro-seek.com (Placidus, tropical)',
    fetchedAt: '2026-08-25',
    signs: {
      ascendant: 'scorpio',
      sun: 'cancer',
      moon: 'leo',
      mercury: 'cancer',
      venus: 'gemini',
      mars: 'aries',
      jupiter: 'taurus',
      saturn: 'sagittarius',
      uranus: 'sagittarius',
      neptune: 'capricorn',
      pluto: 'scorpio',
    },
  },
];
