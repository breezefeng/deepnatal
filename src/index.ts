/**
 * ─────────────────────────────────────────────────────────────
 *  deepnatal — public library entry
 * ─────────────────────────────────────────────────────────────
 *
 *  Most astrology libraries answer every question you ask them.
 *  This one is built to refuse.
 *
 *  Three independent paths compute every chart, and disagreement
 *  is an error rather than something to average away:
 *
 *    1. Timezone   explicit IANA zone via Node ICU historical tzdata,
 *                  cross-checked against coordinate-derived zone
 *    2. Planets    circular-natal-horoscope-js  ×  astronomy-engine
 *    3. Ascendant  a third, pure-geometry path that uses no astrology
 *                  library at all (ecliptic × eastern horizon)
 *
 *  If those disagree beyond tolerance, you get a thrown error, not a chart.
 *
 *  ⚠️ Source-of-truth note for maintainers
 *     These files are copied from the deepnatal.com app at src/lib/astro/.
 *     `npm run check:astro-sync` (repo root) fails the build if they drift.
 *     Do not patch one side only.
 */

export {
  calculateNatalChart,
  calculateWithoutTime,
  localToUtc,
  type BirthData,
  type NatalChart,
  type PartialChart,
  type PlanetPosition,
  type HouseSystem,
} from './ephemeris.ts';

export { ascendantByGeometry, angularDiffDegrees } from './verify.ts';

import { calculateNatalChart, type BirthData } from './ephemeris.ts';
import { ascendantByGeometry, angularDiffDegrees } from './verify.ts';

const SIGNS = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
] as const;

export type SignKey = (typeof SIGNS)[number];

export interface AscendantVerification {
  /** What this engine computes. */
  computed: { sign: SignKey; degreeInSign: number; longitude: number };
  /** Independent pure-geometry recomputation, or null in polar degeneracy. */
  geometric: { sign: SignKey; degreeInSign: number; longitude: number } | null;
  /** Arc-minute gap between the two internal paths. */
  internalAgreementArcmin: number | null;
  /** Max arc-minute gap of the dual-library planetary cross-check. */
  planetaryCrossCheckArcmin: number;
  /** Ascendant is mathematically unstable here (polar latitudes). */
  unstable: boolean;
  /** Non-null when Placidus degraded to whole-sign, with the reason. */
  degradedReason: string | null;
  /**
   * What the ascendant would be if the birth instant were off by exactly one
   * hour in either direction. Always present, because this is the single most
   * useful diagnostic in the whole package: a mishandled DST rule shifts the
   * ascendant by roughly this much, and comparing against these two values
   * turns "probably a timezone bug" from a guess into a measurement.
   */
  oneHourOffsetTest: {
    minusOneHour: { sign: SignKey; degreeInSign: number } | null;
    plusOneHour: { sign: SignKey; degreeInSign: number } | null;
    /** Degrees the ascendant moves per hour here. Varies with latitude. */
    degreesPerHour: number | null;
  };
  /** Populated only when the caller supplied a value to check. */
  claim: {
    input: string;
    matchesSign: boolean;
    /** Null when the claim carried no degree, only a sign. */
    degreeGapArcmin: number | null;
    verdict: 'match' | 'off-by-one-hour' | 'sign-matches-degree-differs' | 'mismatch';
    likelyCause: string | null;
  } | null;
  utc: string;
}

function signOf(longitude: number): { sign: SignKey; degreeInSign: number } {
  const norm = ((longitude % 360) + 360) % 360;
  const idx = Math.min(11, Math.floor(norm / 30));
  return { sign: SIGNS[idx] ?? 'aries', degreeInSign: norm - idx * 30 };
}

/**
 * Parse a human ascendant claim such as "Virgo", "處女", "12 Leo",
 * "Leo 12°34'", or a bare ecliptic longitude like "132.5".
 *
 * Returns null when nothing recognizable is found — callers must treat
 * that as "unverifiable input", never as a mismatch.
 */
function parseClaim(raw: string): { sign: SignKey | null; longitude: number | null } {
  const text = raw.trim().toLowerCase();

  // Bare longitude, e.g. "132.5" or "132.5deg"
  const bare = /^(\d{1,3}(?:\.\d+)?)\s*(?:°|deg|degrees)?$/.exec(text);
  if (bare?.[1]) {
    const lon = Number.parseFloat(bare[1]);
    if (lon >= 0 && lon < 360) return { sign: signOf(lon).sign, longitude: lon };
  }

  const ALIASES: Record<string, SignKey> = {
    aries: 'aries', ari: 'aries', 牡羊: 'aries', 白羊: 'aries', 牡羊座: 'aries', 白羊座: 'aries',
    taurus: 'taurus', tau: 'taurus', 金牛: 'taurus', 金牛座: 'taurus',
    gemini: 'gemini', gem: 'gemini', 雙子: 'gemini', 双子: 'gemini', 雙子座: 'gemini', 双子座: 'gemini',
    cancer: 'cancer', can: 'cancer', 巨蟹: 'cancer', 巨蟹座: 'cancer',
    leo: 'leo', 獅子: 'leo', 狮子: 'leo', 獅子座: 'leo', 狮子座: 'leo',
    virgo: 'virgo', vir: 'virgo', 處女: 'virgo', 处女: 'virgo', 處女座: 'virgo', 处女座: 'virgo',
    libra: 'libra', lib: 'libra', 天秤: 'libra', 天平: 'libra', 天秤座: 'libra',
    scorpio: 'scorpio', sco: 'scorpio', 天蠍: 'scorpio', 天蝎: 'scorpio', 天蠍座: 'scorpio', 天蝎座: 'scorpio',
    sagittarius: 'sagittarius', sag: 'sagittarius', 射手: 'sagittarius', 人馬: 'sagittarius', 射手座: 'sagittarius',
    capricorn: 'capricorn', cap: 'capricorn', 摩羯: 'capricorn', 魔羯: 'capricorn', 摩羯座: 'capricorn',
    aquarius: 'aquarius', aqu: 'aquarius', 水瓶: 'aquarius', 寶瓶: 'aquarius', 水瓶座: 'aquarius',
    pisces: 'pisces', pis: 'pisces', 雙魚: 'pisces', 双鱼: 'pisces', 雙魚座: 'pisces', 双鱼座: 'pisces',
  };

  let sign: SignKey | null = null;
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (text.includes(alias)) { sign = key; break; }
  }

  // Degrees within the sign: "12", "12.5", "12°34'"
  let degreeInSign: number | null = null;
  const dm = /(\d{1,2})\s*(?:°|deg)?\s*(?:(\d{1,2})\s*['′])?/.exec(text.replace(/[^\d°'′.\s]/g, ' '));
  if (dm?.[1]) {
    const deg = Number.parseInt(dm[1], 10);
    const min = dm[2] ? Number.parseInt(dm[2], 10) : 0;
    if (deg < 30 && min < 60) degreeInSign = deg + min / 60;
  }

  if (!sign) return { sign: null, longitude: null };
  const idx = SIGNS.indexOf(sign);
  return {
    sign,
    longitude: degreeInSign === null ? null : idx * 30 + degreeInSign,
  };
}

/**
 * Verify an ascendant — optionally against a value produced by some other tool.
 *
 * This is the reason the package exists. Any astrology site can assert its
 * numbers are right; almost none let you check them from a second direction.
 * Here the ascendant is recomputed by a path that imports no astrology
 * library whatsoever, so the two answers fail independently or not at all.
 *
 * When `claim` is supplied and disagrees, `likelyCause` names the usual
 * suspect rather than declaring a winner — most real disagreements come from
 * timezone/DST handling or house-system settings, not from broken math.
 */
export function verifyAscendant(
  birth: BirthData,
  claim?: string,
): AscendantVerification {
  const chart = calculateNatalChart(birth);
  const utc = new Date(chart.utc);

  /*
   * Recompute the ascendant one hour either side of the stated birth instant.
   *
   * ⚠️ Do not replace this with the folklore constant "one hour = 15 degrees".
   *    That figure is the Earth's rotation rate, not the ascendant's rate of
   *    travel along the ecliptic, and the two only coincide near the equator.
   *    At 60 degrees latitude a single hour can move the ascendant by well
   *    over 30 degrees near the fast-rising signs. Measuring it beats assuming.
   */
  const shiftedAscendant = (deltaHours: number): number | null => {
    const at = new Date(utc.getTime() + deltaHours * 3_600_000);
    return ascendantByGeometry(at, birth.latitude, birth.longitude);
  };
  const minusLon = shiftedAscendant(-1);
  const plusLon = shiftedAscendant(1);
  const oneHourOffsetTest: AscendantVerification['oneHourOffsetTest'] = {
    minusOneHour: minusLon === null ? null : signOf(minusLon),
    plusOneHour: plusLon === null ? null : signOf(plusLon),
    degreesPerHour:
      minusLon === null || plusLon === null
        ? null
        : +(angularDiffDegrees(minusLon, plusLon) / 2).toFixed(2),
  };

  const geoLon = ascendantByGeometry(utc, birth.latitude, birth.longitude);
  const geometric = geoLon === null ? null : { ...signOf(geoLon), longitude: geoLon };

  const internalAgreementArcmin =
    geoLon === null
      ? null
      : +(angularDiffDegrees(chart.ascendant.longitude, geoLon) * 60).toFixed(2);

  let claimReport: AscendantVerification['claim'] = null;
  if (claim && claim.trim()) {
    const parsed = parseClaim(claim);
    if (parsed.sign) {
      const matchesSign = parsed.sign === chart.ascendant.sign;
      const degreeGapArcmin =
        parsed.longitude === null
          ? null
          : +(angularDiffDegrees(chart.ascendant.longitude, parsed.longitude) * 60).toFixed(2);

      /*
       * Does the claim land on the one-hour-shifted ascendant instead of ours?
       *
       * This test runs BEFORE the sign comparison on purpose. An hour of error
       * frequently stays inside the same sign, so a naive "same sign = fine,
       * different sign = timezone" split gets the common case exactly backwards
       * — which is what an earlier version of this function did.
       */
      const NEAR_ARCMIN = 45;
      const gapTo = (lon: number | null): number | null =>
        lon === null || parsed.longitude === null
          ? null
          : angularDiffDegrees(lon, parsed.longitude) * 60;
      const gapMinus = gapTo(minusLon);
      const gapPlus = gapTo(plusLon);
      const hourDirection =
        gapMinus !== null && gapMinus <= NEAR_ARCMIN ? -1
        : gapPlus !== null && gapPlus <= NEAR_ARCMIN ? 1
        : 0;

      let verdict: 'match' | 'off-by-one-hour' | 'sign-matches-degree-differs' | 'mismatch';
      if (matchesSign && (degreeGapArcmin === null || degreeGapArcmin <= 30)) verdict = 'match';
      else if (hourDirection !== 0) verdict = 'off-by-one-hour';
      else if (matchesSign) verdict = 'sign-matches-degree-differs';
      else verdict = 'mismatch';

      let likelyCause: string | null = null;
      if (verdict === 'off-by-one-hour') {
        const dir = hourDirection === -1 ? 'one hour EARLIER' : 'one hour LATER';
        likelyCause =
          `Measured, not guessed: the supplied value matches this engine's ascendant for a birth ` +
          `instant ${dir} than the one given. That is the signature of a timezone or daylight ` +
          `saving rule applied differently, not of an astronomy error. Historical DST is the ` +
          `usual culprit — Taiwan 1945-1961 and 1974-1979, mainland China 1986-1991, Japan ` +
          `1948-1951 — and many tools silently apply today's UTC offset to a past date. ` +
          `Use inspect_historical_timezone on this date to see which side is right.`;
      } else if (verdict === 'sign-matches-degree-differs') {
        likelyCause =
          'Same sign, different degree, and it does not correspond to a one-hour shift. ' +
          'Likely an ephemeris or zodiac convention difference (tropical vs sidereal, apparent ' +
          'vs mean obliquity), different birth coordinates, or rounding at the source.';
      } else if (verdict === 'mismatch') {
        likelyCause =
          'The values disagree and the gap does not correspond to a one-hour offset. Check the ' +
          'birth coordinates and confirm both sides used the same birth time, then confirm the ' +
          'other tool is reporting an ascendant rather than a sun or moon sign — that mix-up is ' +
          'more common than a genuine calculation fault.';
      }

      claimReport = { input: claim, matchesSign, degreeGapArcmin, verdict, likelyCause };
    } else {
      claimReport = {
        input: claim,
        matchesSign: false,
        degreeGapArcmin: null,
        verdict: 'mismatch',
        likelyCause: 'Could not parse a zodiac sign out of the supplied value, so nothing was compared.',
      };
    }
  }

  return {
    computed: {
      sign: chart.ascendant.sign as SignKey,
      degreeInSign: +chart.ascendant.degreeInSign.toFixed(4),
      longitude: +chart.ascendant.longitude.toFixed(4),
    },
    geometric: geometric && {
      sign: geometric.sign,
      degreeInSign: +geometric.degreeInSign.toFixed(4),
      longitude: +geometric.longitude.toFixed(4),
    },
    internalAgreementArcmin,
    planetaryCrossCheckArcmin: chart.crossCheckMaxArcmin,
    unstable: chart.ascendantUnstable,
    degradedReason: chart.degradedReason,
    oneHourOffsetTest,
    claim: claimReport,
    utc: chart.utc,
  };
}

/**
 * Resolve a local birth date/time to UTC and report what the historical
 * timezone database actually did on that date.
 *
 * Exposed on its own because the single most common way an online chart goes
 * wrong is not the astronomy — it is quietly applying today's UTC offset to a
 * date when the offset was different.
 */
export function inspectTimezone(
  date: string,
  time: string,
  timezone: string,
): {
  utc: string;
  offsetMinutes: number;
  offsetHours: number;
  dstActive: boolean;
  standardOffsetMinutes: number;
  note: string | null;
} {
  const { utc, offsetMinutes } = localToUtcImported(date, time, timezone);

  // January vs July baseline tells us the zone's standard (non-DST) offset.
  const year = Number.parseInt(date.slice(0, 4), 10);
  const janOffset = localToUtcImported(`${year}-01-15`, '12:00', timezone).offsetMinutes;
  const julOffset = localToUtcImported(`${year}-07-15`, '12:00', timezone).offsetMinutes;
  const standardOffsetMinutes = Math.min(janOffset, julOffset);
  const dstActive = offsetMinutes > standardOffsetMinutes;

  return {
    utc: utc.toISOString(),
    offsetMinutes,
    offsetHours: offsetMinutes / 60,
    dstActive,
    standardOffsetMinutes,
    note: dstActive
      ? `Daylight saving time was in effect: offset ${offsetMinutes / 60}h instead of the ` +
        `standard ${standardOffsetMinutes / 60}h. Tools that ignore this land one hour off, ` +
        'which is roughly 15 degrees of ascendant.'
      : null,
  };
}

import { localToUtc as localToUtcImported } from './ephemeris.ts';
