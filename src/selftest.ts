/**
 * Self-test / regression suite.
 *
 *   npm test
 *
 * ── Written for people who cannot read the astronomy ──────────
 *
 * You do not need to understand a single formula here. You need to know
 * whether the last line is green or red. If it is red, it names the
 * boundary that broke and by how much.
 *
 * This file is why the package is open source at all: "verified three
 * independent ways" is worth nothing if you cannot run the verification
 * yourself. So run it.
 *
 * Four gates:
 *   ① Timezone   local time → UTC via Node ICU's full historical tzdata
 *   ② Planets    two independent engines cross-checked (tol. 15', typ. <1')
 *   ③ Ascendant  recomputed by a third pure-geometry path
 *   ④ External   checked against astro-seek captures — catches the case
 *                where all three internal paths share a wrong assumption
 */

import { FIXTURES, FIXTURE_TARGET, EXTERNAL_CHECKS } from './fixtures.ts';
import { calculateNatalChart, calculateWithoutTime } from './ephemeris.ts';
import { ascendantByGeometry, angularDiffDegrees } from './verify.ts';

/**
 * 上升点两法允许的最大分歧（角分）。
 * 实测正常纬度 0.6–2.4 角分。5 角分 = 星座宽度的 1/360，仍然极严格。
 * 太紧会因为两库的正常精度差异产生假警报。
 */
const ASC_TOLERANCE_ARCMIN = 5;

let pass = 0;
const failures: string[] = [];
const notes: string[] = [];

console.log(`星历回归测试 —— ${FIXTURES.length} 组边界（目标 ${FIXTURE_TARGET}）\n`);

for (const f of FIXTURES) {
  const label = f.name.padEnd(34);
  try {
    const chart = calculateNatalChart(f.birth);
    const problems: string[] = [];

    // ── 门槛 ②：行星交叉验算（在 calculateNatalChart 内部已强制，这里只记录）
    if (chart.crossCheckMaxArcmin > 5) {
      problems.push(`行星双实现偏差偏大 ${chart.crossCheckMaxArcmin} 角分`);
    }

    // ── 门槛 ③：上升点独立几何复算
    const geoAsc = ascendantByGeometry(
      new Date(chart.utc), f.birth.latitude, f.birth.longitude,
    );
    if (geoAsc === null) {
      problems.push('几何法求不到上升点');
    } else {
      const diffArcmin = angularDiffDegrees(geoAsc, chart.ascendant.longitude) * 60;
      // 极区例外：上升点概念退化，两法可能相差整 180°（见 ephemeris.ts 说明）。
      // 这种情况下只要产品明确标了 ascendantUnstable 就算通过 —— 不隐瞒才是正确行为。
      const polarFlip =
        chart.ascendantUnstable && Math.abs(diffArcmin - 180 * 60) < ASC_TOLERANCE_ARCMIN;
      if (polarFlip) {
        notes.push(
          `${f.name}: 极区上升点翻转 180°（库 ${chart.ascendant.longitude.toFixed(1)}° / ` +
            `几何 ${geoAsc.toFixed(1)}°）—— 已标记 ascendantUnstable，UI 须提示用户`,
        );
      } else if (diffArcmin > ASC_TOLERANCE_ARCMIN) {
        problems.push(
          `上升点两法不一致：库 ${chart.ascendant.longitude.toFixed(3)}° ` +
            `vs 几何 ${geoAsc.toFixed(3)}°（差 ${diffArcmin.toFixed(2)} 角分）`,
        );
      }
    }

    // ── 宫位制降级是否符合预期
    if (f.expectHouseSystem && chart.houseSystem !== f.expectHouseSystem) {
      problems.push(`宫位制应为 ${f.expectHouseSystem}，实际 ${chart.houseSystem}`);
    }

    if (f.expectThrows) problems.push('预期抛错但没有抛');

    if (problems.length) {
      failures.push(`${f.name}\n      ${problems.join('\n      ')}`);
      console.log(`  ❌ ${label} ${(problems[0] ?? '').slice(0, 60)}`);
    } else {
      pass++;
      const deg = `${chart.ascendant.sign} ${chart.ascendant.degreeInSign.toFixed(1)}°`;
      console.log(
        `  ✅ ${label} 上升 ${deg.padEnd(20)} ` +
          `${chart.houseSystem === 'whole-sign' ? '(已降级整宫制)' : ''}`,
      );
      if (chart.degradedReason) notes.push(`${f.name}: ${chart.degradedReason}`);
    }
  } catch (e) {
    if (f.expectThrows) {
      pass++;
      console.log(`  ✅ ${label} 按预期拒绝计算`);
    } else {
      failures.push(`${f.name}\n      ${(e as Error).message.split('\n').join('\n      ')}`);
      console.log(`  ❌ ${label} 抛错: ${((e as Error).message.split('\n')[0] ?? '').slice(0, 55)}`);
    }
  }
}

// ── 门槛 ④：外部权威源核对 ───────────────────────────────────
console.log(`\n外部权威源核对（${EXTERNAL_CHECKS.length} 组）`);
let extPass = 0;
let extTotal = 0;
for (const check of EXTERNAL_CHECKS) {
  const f = FIXTURES.find((x) => x.name === check.fixtureName);
  if (!f) {
    failures.push(`EXTERNAL_CHECKS 指向不存在的 fixture: ${check.fixtureName}`);
    continue;
  }
  const chart = calculateNatalChart(f.birth);
  const ours: Record<string, string> = { ascendant: chart.ascendant.sign };
  for (const p of chart.planets) ours[p.planet] = p.sign;

  const bad: string[] = [];
  for (const [body, theirSign] of Object.entries(check.signs)) {
    extTotal++;
    if (ours[body] === theirSign) extPass++;
    else bad.push(`${body}: 我们 ${ours[body]} / 对方 ${theirSign}`);
  }
  console.log(
    `  ${bad.length === 0 ? '✅' : '❌'} ${check.fixtureName} vs ${check.source}` +
      ` (${check.fetchedAt})`,
  );
  if (bad.length) failures.push(`外部核对 ${check.fixtureName}\n      ` + bad.join('\n      '));
}
console.log(`  星座一致 ${extPass}/${extTotal}`);

// ── 无出生时间的降级路径 ─────────────────────────────────────
console.log('\n无出生时间降级路径');
try {
  const partial = calculateWithoutTime({
    date: '1988-07-15', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 121.47,
  });
  const hasAscWarning = partial.unavailable.some((u) => u.field === 'ascendant');
  console.log(
    `  ${hasAscWarning ? '✅' : '❌'} 明确告知无法计算上升` +
      `（月亮当天移动 ${partial.moonUncertaintyDegrees}°` +
      `${partial.moonSignAmbiguous ? '，且跨星座 → 已提示用户' : ''}）`,
  );
  if (!hasAscWarning) failures.push('降级路径未告知上升不可用');
} catch (e) {
  failures.push(`降级路径抛错: ${(e as Error).message}`);
  console.log(`  ❌ ${(e as Error).message.split('\n')[0]}`);
}

// ── 结论 ─────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(62));
console.log(`边界测试 ${pass}/${FIXTURES.length} 通过`);
if (notes.length) {
  console.log('\n降级提示（这些是正常行为，UI 需向用户说明）：');
  notes.forEach((n) => console.log(`  · ${n}`));
}
if (failures.length) {
  console.log('\n失败详情：');
  failures.forEach((f) => console.log(`  ❌ ${f}`));
}

const gateOpen =
  failures.length === 0 && pass === FIXTURES.length && FIXTURES.length >= FIXTURE_TARGET && extPass === extTotal;

console.log('');
if (gateOpen) {
  console.log(`✅ PASS — ${pass}/${FIXTURES.length} boundary cases + ${extPass}/${extTotal} external cross-checks`);
  console.log('   All three paths agree, and they agree with an outside source.');
} else {
  console.log(`🔴 FAIL — ${pass}/${FIXTURES.length} boundary cases + ${extPass}/${extTotal} external cross-checks`);
  console.log('   Do not ship. One wrong ascendant invalidates every claim this package makes.');
}
process.exit(gateOpen ? 0 : 1);
