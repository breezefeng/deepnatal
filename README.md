# deepnatal

**A natal chart engine that cross-verifies every result three independent ways — and refuses to answer when it can't.**

Ships as both a TypeScript library and an [MCP](https://modelcontextprotocol.io) server for Claude, Cursor, Codex, Cline and other agents.

```bash
npx -y deepnatal-mcp
```

[![npm](https://img.shields.io/npm/v/deepnatal)](https://www.npmjs.com/package/deepnatal) [![test](https://github.com/breezefeng/deepnatal/actions/workflows/test.yml/badge.svg)](https://github.com/breezefeng/deepnatal/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## Why this exists

Ask any astrology site for a birth chart and you get an answer. You almost never get a way to check it.

That matters more than it sounds, because the ascendant — the rising sign — moves about one degree every four minutes. Get the UTC instant wrong by an hour and it shifts by roughly half a sign. The result still looks completely plausible. Nothing about it announces that it's wrong.

And an hour is easy to lose. Taiwan observed daylight saving in 1945–1961 and again in 1974–1979. Mainland China did from 1986 to 1991. Japan did from 1948 to 1951. Plenty of tools quietly apply *today's* UTC offset to a 1988 birth date and hand back a chart that's off by exactly one hour.

This package is built around the opposite assumption: **a result you can't check is not a result.**

## How it verifies

Three independent paths compute every chart. Disagreement is an error, not something to average away.

| Layer | Primary | Independent check |
|---|---|---|
| **Timezone** | Explicit IANA zone, Node ICU historical `tzdata` | Coordinate-derived zone lookup |
| **Planets** | `circular-natal-horoscope-js` | `astronomy-engine` |
| **Ascendant** | Astrology-library house calculation | Pure spherical geometry — ecliptic × eastern horizon, no astrology library involved |

Typical agreement in practice is under one arcminute. Past tolerance, the call throws rather than returning a chart.

It also degrades honestly where the math genuinely breaks down:

- **Above 66° latitude**, Placidus houses are undefined. The engine falls back to whole-sign and tells you it did, instead of emitting silent nonsense.
- **Without a birth time**, the ascendant, midheaven and houses are simply omitted with reasons. No substituting noon. If the Moon changed sign that day — which happens on nearly half of all dates — that's reported too.
- **Inside a DST transition gap**, where a local time either doesn't exist or happens twice, it throws and asks you to disambiguate.

## Verify it yourself

A README asserting "cross-verified" is worth nothing on its own. The suite ships inside the published package, so you can run it against the exact bytes you installed:

```bash
npm i deepnatal
node node_modules/deepnatal/dist/selftest.js
```

```
✅ PASS — 21/21 boundary cases + 11/11 external cross-checks
   All three paths agree, and they agree with an outside source.
```

The 21 boundary cases are chosen to be the ones that break things, not the ones that are easy: China's 1986–1991 DST window and a same-year winter control, Taiwan 1979, Japan's 1948–1951 GHQ period, a time that never existed because a DST jump skipped it, and latitudes inside the Arctic Circle where Placidus is undefined.

The 11 external checks compare against values captured from astro-seek. Those exist because the three internal paths share assumptions — tropical zodiac, apparent geocentric positions, true ecliptic of date — and if an assumption itself were wrong, all three would agree on the same wrong answer. Only an outside source catches that.

CI runs the suite on Node 20/22/24 under a deliberately non-UTC system clock, so any accidental dependence on the host timezone fails loudly.

## Quick start

```bash
npm install deepnatal
```

```ts
import { calculateNatalChart, verifyAscendant } from 'deepnatal';

const birth = {
  date: '1988-07-15',
  time: '14:30',
  timezone: 'Asia/Shanghai',   // the BIRTHPLACE's zone, never the user's current one
  latitude: 31.23,
  longitude: 121.47,
};

const chart = calculateNatalChart(birth);
chart.ascendant;             // { sign: 'scorpio', degreeInSign: 10.37, ... }
chart.crossCheckMaxArcmin;   // 0.467 — how far the two engines disagreed
```

### Checking somebody else's answer

The reason this package exists. Pass a result from any other tool as `claim`:

```ts
verifyAscendant(birth, 'Scorpio 23.0');
```

```jsonc
{
  "computed":  { "sign": "scorpio", "degreeInSign": 10.37 },
  "geometric": { "sign": "scorpio", "degreeInSign": 10.37 },  // independent path
  "internalAgreementArcmin": 0,
  "oneHourOffsetTest": {
    "minusOneHour": { "sign": "libra",   "degreeInSign": 27.66 },
    "plusOneHour":  { "sign": "scorpio", "degreeInSign": 22.98 },
    "degreesPerHour": 12.66
  },
  "claim": {
    "verdict": "off-by-one-hour",
    "likelyCause": "Measured, not guessed: the supplied value matches this engine's
                    ascendant for a birth instant one hour LATER than the one given..."
  }
}
```

Note `degreesPerHour: 12.66`. The usual rule of thumb says an hour is 15° — that's the Earth's rotation rate, not the ascendant's rate of travel along the ecliptic, and the two only agree near the equator. This library measures it per chart instead of assuming it.

## MCP server

```bash
npx -y deepnatal-mcp
```

<details>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "deepnatal": { "command": "npx", "args": ["-y", "deepnatal-mcp"] }
  }
}
```
</details>

<details>
<summary><b>Cursor</b> — <code>.cursor/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "deepnatal": { "command": "npx", "args": ["-y", "deepnatal-mcp"] }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add deepnatal -- npx -y deepnatal-mcp
```
</details>

### Tools

| Tool | What it does |
|---|---|
| `calculate_natal_chart` | Ten planets with sign, degree, house, retrograde; ascendant, midheaven, twelve cusps. Fails rather than returning a chart the two engines disagree on. |
| `calculate_chart_without_birth_time` | Only what's knowable without a time. Lists what's missing and why. Flags an ambiguous moon sign. |
| `verify_ascendant` | Recomputes via pure geometry and adjudicates a value from another tool. Accepts `Virgo`, `處女座`, `12 Leo`, `Leo 12°34'`, or a bare longitude. |
| `inspect_historical_timezone` | What the historical tzdata actually did on that date, and whether DST was in effect. |

Everything runs locally in the agent's own process. Birth data is about as sensitive as personal data gets, and none of it leaves the machine — there is no network call anywhere in this package.

**Why let an agent call this instead of reasoning it out?** Because a language model asked to work out a rising sign will produce a confident, plausible, wrong answer, and nothing downstream can detect that. This server returns computed facts and its own uncertainty. It never interprets.

---

## 中文說明

**deepnatal** 是一套會自我驗算的本命盤計算引擎——算不出來時它會拒絕回答，而不是給你一個看起來合理的答案。

上升星座每四分鐘移動約一度。時區算錯一小時，上升就偏掉大半個星座，而結果看起來完全正常，不會有任何地方提示你它是錯的。

而一小時很容易丟。台灣在 1945–1961、1974–1979 實施過夏令時間，中國大陸是 1986–1991，日本是 1948–1951。不少工具會把**今天**的時區偏移直接套到 1988 年的出生日期上。

三條獨立路徑同時計算，彼此不一致就報錯：

1. **時區層**　明確 IANA 時區 + Node ICU 歷史 tzdata，與座標反查時區交叉核對
2. **行星層**　`circular-natal-horoscope-js` × `astronomy-engine` 兩套獨立演算法
3. **上升層**　純球面幾何第三條路（黃道與東方地平線交點），完全不依賴任何占星函式庫

實測吻合度在 1 角分以內。超過容許值就丟出錯誤，不回傳星盤。

`verifyAscendant()` 可以用來檢查**任何其他工具**算出的上升是否正確。它不猜原因——而是實際重算前後各一小時的上升點，如果對方的答案正好落在那裡，就能證明差異來自時區處理而非天文計算。

完整工具與說明見 [deepnatal.com](https://deepnatal.com)。

---

## What this does not prove

Being straight about the boundaries is part of the point.

- Cross-verification catches implementation bugs and drift. It cannot prove the shared conventions are the right ones — all three paths assume the tropical zodiac, apparent geocentric positions and the true ecliptic of date.
- A reproducible chart says nothing about whether astrology predicts anything. This package computes positions. It makes no claim about meaning.
- Two tools can legitimately differ over house system, zodiac (tropical vs sidereal), ephemeris, node convention or rounding. `verify_ascendant` distinguishes a one-hour offset from these, but it doesn't declare a winner in matters of convention.
- Wrong birth data still produces a technically correct chart of the wrong moment. Nothing downstream can rescue that.

## Licensing

MIT. The dependency chain is deliberately kept clear for redistribution:

| Package | License |
|---|---|
| `circular-natal-horoscope-js` | Unlicense (public domain) |
| `astronomy-engine` | MIT |

Notably **not** Swiss Ephemeris (`sweph` / `swisseph`). Its dual `AGPL-3.0-or-later OR LGPL-3.0-or-later` listing is misleading: the LGPL option requires purchasing an Astrodienst commercial license first. Without one you're on AGPL, which reaches network services and would require open-sourcing everything that touches it. That constraint is why most hosted astrology products can't ship their calculation layer as an open package — this one can.

## Credits

This is the calculation layer of [deepnatal.com](https://deepnatal.com), extracted verbatim — the site runs the same code that ships here, so any chart it produces can be reproduced locally against this package.

Issues and PRs: [github.com/breezefeng/deepnatal](https://github.com/breezefeng/deepnatal)
