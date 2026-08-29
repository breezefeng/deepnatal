#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────
 *  deepnatal MCP server
 * ─────────────────────────────────────────────────────────────
 *
 *  Exposes the deterministic layer to Claude, Cursor, Codex, Cline and any
 *  other MCP-compatible agent.
 *
 *  ── Why an LLM should not compute a chart itself ────────────
 *
 *  Ascendant is the highest-risk number in astrology: it changes roughly
 *  every four minutes of birth time, and a wrong timezone offset moves it
 *  about 15 degrees — often a whole sign. A language model asked to "work
 *  out the rising sign" will produce a confident, plausible, wrong answer,
 *  and nothing downstream can detect that.
 *
 *  So the contract here is deliberately narrow: this server returns computed
 *  facts and its own uncertainty. It never interprets, and when the inputs
 *  do not support an answer it returns an error instead of a guess.
 *
 *  ⚠️ Tools MUST stay side-effect free and MUST NOT phone home.
 *     Birth data is among the most sensitive things a user can type.
 *     Everything below runs locally in the agent's own process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { calculateNatalChart, calculateWithoutTime } from './ephemeris.ts';
import { verifyAscendant, inspectTimezone } from './index.ts';

const PKG_VERSION = '0.1.0';

const server = new McpServer({ name: 'deepnatal', version: PKG_VERSION });

/** Shared birth-input schema. */
const birthShape = {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Local birth date at the birthplace, YYYY-MM-DD.'),
  time: z.string().regex(/^\d{2}:\d{2}$/)
    .describe('Local clock time at the birthplace, HH:mm 24-hour, as written on the birth record.'),
  timezone: z.string()
    .describe('IANA timezone of the BIRTHPLACE, e.g. Asia/Taipei. Never the user\'s current zone — people are routinely asked about a birth in another country.'),
  latitude: z.number().min(-90).max(90).describe('Birthplace latitude, decimal degrees.'),
  longitude: z.number().min(-180).max(180).describe('Birthplace longitude, decimal degrees.'),
};

/** Uniform text payload. Errors are surfaced, never smoothed over. */
function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown, hint?: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: JSON.stringify(
        {
          refused: true,
          reason: message,
          hint: hint ??
            'This engine throws instead of returning a chart it cannot stand behind. ' +
            'Fix the input rather than retrying — the same input will fail the same way.',
        },
        null, 2,
      ),
    }],
  };
}

// ─────────────────────────────────────────────────────────────
//  1. Full natal chart
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'calculate_natal_chart',
  {
    title: 'Calculate a natal chart',
    description:
      'Compute a full natal/birth chart: ten planets with sign, degree, house and retrograde ' +
      'status, plus ascendant, midheaven and twelve house cusps. Every result is cross-checked ' +
      'by two independent astronomy implementations and the call FAILS rather than returning a ' +
      'chart when they disagree. Use this whenever a user asks for a birth chart, rising sign, ' +
      'or planetary placements — do not attempt the arithmetic yourself. Requires an exact birth ' +
      'time; if the time is unknown use calculate_chart_without_birth_time instead.',
    inputSchema: birthShape,
  },
  async (birth) => {
    try {
      const chart = calculateNatalChart(birth);
      return ok({
        ...chart,
        _verification: {
          planetaryCrossCheckArcmin: chart.crossCheckMaxArcmin,
          note:
            'crossCheckMaxArcmin is the largest disagreement between the two independent ' +
            'planetary engines. Typical value is under 1 arcminute; anything above 15 would ' +
            'have thrown instead of returning.',
        },
      });
    } catch (e) {
      return fail(e);
    }
  },
);

// ─────────────────────────────────────────────────────────────
//  2. Unknown birth time — degrade honestly
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'calculate_chart_without_birth_time',
  {
    title: 'Calculate a chart without a birth time',
    description:
      'For users who do not know their birth time. Returns only what is genuinely knowable ' +
      'without it, and explicitly lists what is not: ascendant, midheaven and all house ' +
      'positions are omitted with reasons rather than estimated. Also reports whether the Moon ' +
      'changed sign during that day — it does on nearly half of all dates, which means the moon ' +
      'sign itself is undetermined without a time. Never substitute noon and present the result ' +
      'as fact; that is exactly what this tool exists to prevent.',
    inputSchema: {
      date: birthShape.date,
      timezone: birthShape.timezone,
      latitude: birthShape.latitude,
      longitude: birthShape.longitude,
    },
  },
  async (birth) => {
    try {
      return ok(calculateWithoutTime(birth));
    } catch (e) {
      return fail(e);
    }
  },
);

// ─────────────────────────────────────────────────────────────
//  3. Independent ascendant verification  ★ the point of this package
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'verify_ascendant',
  {
    title: 'Independently verify an ascendant',
    description:
      'Recompute the ascendant along a third path that imports no astrology library at all — ' +
      'pure spherical geometry, the intersection of the ecliptic with the eastern horizon — and ' +
      'report how far it lands from the primary engine. Optionally pass a value produced ' +
      'ELSEWHERE (another website, an app, a printed chart) as `claim` and this will tell you ' +
      'whether it holds up and, when it does not, name the likely cause. Use this when a user ' +
      'says two sites disagree about their rising sign, doubts a result, or asks which one is ' +
      'correct. Accepts claims like "Virgo", "處女座", "12 Leo", "Leo 12°34\'" or a bare ' +
      'ecliptic longitude.',
    inputSchema: {
      ...birthShape,
      claim: z.string().optional()
        .describe('Optional ascendant produced by some other tool, to be checked against this engine.'),
    },
  },
  async ({ claim, ...birth }) => {
    try {
      return ok(verifyAscendant(birth, claim));
    } catch (e) {
      return fail(
        e,
        'Verification could not run because the chart itself could not be computed. ' +
        'Resolve the input problem above first — a disagreement cannot be adjudicated ' +
        'when one side has no valid answer.',
      );
    }
  },
);

// ─────────────────────────────────────────────────────────────
//  4. Historical timezone / DST inspection
// ─────────────────────────────────────────────────────────────

server.registerTool(
  'inspect_historical_timezone',
  {
    title: 'Inspect historical timezone and DST',
    description:
      'Resolve a local birth date and time to UTC using historical timezone rules, and report ' +
      'whether daylight saving time was actually in effect on that date. This is the single ' +
      'most common source of wrong charts: many tools apply the PRESENT-DAY offset to a past ' +
      'date. Taiwan observed DST 1945-1961 and 1974-1979, mainland China 1986-1991, Japan ' +
      '1948-1951 — a birth inside those windows is an hour off in tools that ignore them, ' +
      'which moves the ascendant about 15 degrees. Use this to explain WHY two charts differ.',
    inputSchema: {
      date: birthShape.date,
      time: birthShape.time,
      timezone: birthShape.timezone,
    },
  },
  async ({ date, time, timezone }) => {
    try {
      return ok(inspectTimezone(date, time, timezone));
    } catch (e) {
      return fail(
        e,
        'This usually means the local time does not exist or is ambiguous — the hour a DST ' +
        'transition skips, or the hour it repeats. Ask the user whether the time was before ' +
        'or after the clock change.',
      );
    }
  },
);

// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol; diagnostics go to stderr.
  process.stderr.write(`deepnatal MCP server v${PKG_VERSION} ready (stdio)\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`deepnatal MCP server failed to start: ${String(e)}\n`);
  process.exit(1);
});
