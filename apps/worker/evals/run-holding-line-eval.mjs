// The holding line composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/holding-line.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/channel/router/holding-line.ts builds -
// REPLICATED here, as the turn-apology eval replicates apology.ts, because that module sits
// behind the web app's `~/` alias. The SKILL body and the model routing ARE imported live,
// so a skill edit or a re-tiering re-keys the cache and shows up as a miss.
//
// WHAT IS AT STAKE. This line goes out while a slow answer is still being written, ahead
// of it. A line that answers, hints, reassures or promises a time is worse
// than no line, because the real answer lands seconds later and contradicts it.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-holding-line-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-holding-line-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-holding-line-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS: an unsendable body (the composer's own refusals()), and too few distinct
// lines across the plain draws - a composed line that never varies is a constant with an
// API bill. Everything else is the judge's bar (JUDGE_MIN per draw).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { normalizeForCompare } from './lib/variation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'holding-line.md');

// ── the corpus: draws, since the stage is blind ─────────────────────────────

/** Out of the plain English draws, how many distinct lines the corpus must contain. */
const MIN_DISTINCT = 3;

const WATCH =
  'Says Hale is on it and the answer is coming. Nothing about what the answer is, what Hale is doing, or when it lands. No apology.';

const FIXTURES = [
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `en-draw-${i + 1}`,
    language: 'en',
    rejected: [],
    countsTowardVariance: true,
    watchFor: WATCH,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `fr-draw-${i + 1}`,
    language: 'fr',
    rejected: [],
    countsTowardVariance: false,
    watchFor: `${WATCH} It must be written in FRENCH.`,
  })),
  {
    id: 'recompose-promised-time',
    language: 'en',
    rejected: [
      {
        line: "I'm on it - back in a minute.",
        problems: ['promised_a_time'],
      },
    ],
    countsTowardVariance: false,
    watchFor: `${WATCH} The refused body promised a time; the fix drops it and keeps the meaning.`,
  },
];

// ── the composer's request shape and post-processing, replicated ────────────

const LINE_TOOL_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
};

function holdingLineUserMessage(language, rejected = []) {
  const base = { situation: 'answer_still_coming', language };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

const MAX_TOKENS = 96;

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts. */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[•·]/g, ''],
];

function flatten(text) {
  let out = text;
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Mirrors `refusals` in holding-line.ts.
const LINK_SHAPE = /https?:\/\/|www\./i;
const PROMISED_TIME =
  /\b(shortly|momentarily|in a (minute|moment|sec|second|bit|jiffy)|any (minute|moment) now|right back)\b/i;
const APP_POINTER = /\b(the app|in-app|your dashboard|the website|villagehale)\b/i;

function refusals(body) {
  if (body === '') return ['empty'];
  const found = [];
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (/\d/.test(body)) found.push('carries_number');
  if (PROMISED_TIME.test(body)) found.push('promised_a_time');
  if (APP_POINTER.test(body)) found.push('points_at_the_app');
  return found;
}

// ── the judge ────────────────────────────────────────────────────────────────

// Scoped to MEANING: every mechanical property is already decided by refusals() above.
const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring the MEANING of ONE text message Hale sends a parent',
  'while their answer is still being written. Hale composed it BLIND: it was shown nothing',
  'about the parent or what they asked - only that the answer is still coming, and which',
  'language to write in. The real answer arrives right after this line.',
  'IMPORTANT: links, digits and times are ALREADY verified mechanically, and sentence count,',
  'length and punctuation are the writer\'s own. Do not score any of them. Judge only what the',
  'message MEANS and whether it sounds like Hale.',
  'You are given the message, the language and watchFor. Score 1-5.',
  'A 5 says plainly, in the first person and in the requested language, that Hale is on it',
  'and the answer is coming - like a competent friend glancing up from their phone.',
  'A LOW score is any of: hinting at or pre-empting the answer, or reassuring about the',
  'substance ("that should be fine", "good news"); claiming what Hale is doing to get it',
  '("searching", "checking the schedule"); apologising for the wait or implying something',
  'went wrong; a greeting, sign-off, hype or emoji; support-desk language ("your request',
  'has been received"); third person ("Hale is"); the wrong language.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN_LINE =
  'Hi! Good news, I checked the schedule and it looks fine 😊. Back in 2 minutes - see https://villagehale.com, ok?';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const subjectLane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'holding-line', cachedOnly, getClient, cost);

  console.log(
    `holding-line eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${FIXTURES.length} draws\n`);

  const results = [];
  for (const fixture of FIXTURES) {
    const raw = broken
      ? BROKEN_LINE
      : (
          await cachedToolCall({
            tag: `holding-line:${fixture.id}`,
            model,
            lane: subjectLane,
            system: skill.instructions,
            userMessage: holdingLineUserMessage(fixture.language, fixture.rejected),
            toolName: 'holding_line',
            toolSchema: LINE_TOOL_SCHEMA,
            toolDescription: 'Return the one line the parent sees while the answer is coming.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.line;

    const body = flatten(String(raw ?? ''));
    const failures = refusals(body);
    // Skipped in broken mode: the deterministic layer alone must reject the stand-in.
    if (!broken) {
      const verdict = await judge(fixture.id, {
        message: body,
        language: fixture.language,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, body, failures });
  }

  console.log('--- lines ---');
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} "${r.body}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const variance = results.filter((r) => r.fixture.countsTowardVariance);
  const distinct = new Set(variance.map((r) => normalizeForCompare(r.body))).size;
  const tooSame = distinct < MIN_DISTINCT;
  const unsendable = results.filter((r) => r.failures.some((f) => !f.startsWith('judge:'))).length;

  console.log('\n--- corpus metrics ---');
  console.log(
    `UNSENDABLE lines:   ${unsendable}  (0 required - an unsendable line is simply not sent)`,
  );
  console.log(
    `judge below ${JUDGE_MIN}:      ${results.filter((r) => r.failures.some((f) => f.startsWith('judge:'))).length}  (0 required)`,
  );
  console.log(`distinct lines:     ${distinct}/${variance.length}  (${MIN_DISTINCT}+ required)`);
  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0) && !tooSame;
  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one gate): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('holding-line eval harness error:', err);
  process.exit(2);
});
