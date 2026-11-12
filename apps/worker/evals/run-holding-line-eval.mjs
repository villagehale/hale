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
// THE HARD ZEROS: an unsendable body, and too few distinct lines across the plain draws - a
// composed line that never varies is a constant with an API bill. Unsendable is the
// composer's own two gates, run in its own loop: the mechanical refusals() (empty, a link,
// a digit) and the PRODUCTION meaning judge (holding-line-judge.ts: a promised time, or an
// app or a website, in any language). Everything else is the quality judge's bar
// (JUDGE_MIN per draw).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register, tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import { normalizeForCompare } from './lib/variation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'holding-line.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const MEANING_JUDGE_SRC = join(WEB_ROOT, 'lib', 'channel', 'router', 'holding-line-judge.ts');

// The meaning judge's request is IMPORTED, not replicated: it sits behind the web app's
// `~/` alias, so the web tsconfig is registered for that one import.
register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });

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
  // The line is written in the language of the text it covers, any tag the screen reads.
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `zh-draw-${i + 1}`,
    language: 'zh',
    rejected: [],
    countsTowardVariance: false,
    watchFor: `${WATCH} It must be written in CHINESE.`,
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
  {
    // A Chinese line the meaning judge refused for a time goes back once with the reason.
    id: 'zh-recompose-promised-time',
    language: 'zh',
    rejected: [{ line: '我马上回来告诉你', problems: ['promised_a_time'] }],
    countsTowardVariance: false,
    watchFor: `${WATCH} It must be written in CHINESE. The refused body promised a time (马上); the fix drops it and keeps the meaning.`,
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

/** Mirrors `MAX_COMPOSE_ATTEMPTS` in holding-line.ts: a refused line goes back once. */
const MAX_COMPOSE_ATTEMPTS = 2;

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

// Mirrors the MECHANICAL `refusals` in holding-line.ts. A promised time or an app/website
// is not a pattern here: it is the production meaning judge, below.
const LINK_SHAPE = /https?:\/\/|www\./i;

function refusals(body) {
  if (body === '') return ['empty'];
  const found = [];
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (/\d/.test(body)) found.push('carries_number');
  return found;
}

/**
 * The composer's second gate, as createHoldingLine runs it on a line refusals() passed:
 * the production holding-line-judge request, replayed from the cache. A verdict that is
 * not yes/no is production's `judge_failed`: nothing is sent, so it counts as unsendable.
 */
async function meaningProblems(meaningJudge, tag, body, run) {
  const request = await meaningJudge.holdingLineJudgeRequest(body);
  const { value } = await cachedToolCall({
    tag,
    lane: request.lane,
    system: request.system,
    userMessage: request.userMessage,
    toolName: request.toolName,
    toolSchema: request.toolSchema,
    toolDescription: request.toolDescription,
    maxTokens: request.maxTokens,
    ...run,
  });
  const time = value?.promises_a_time;
  const place = value?.points_at_an_app;
  if ((time !== 'yes' && time !== 'no') || (place !== 'yes' && place !== 'no')) {
    return ['judge_failed'];
  }
  const problems = [];
  if (time === 'yes') problems.push('promised_a_time');
  if (place === 'yes') problems.push('points_at_the_app');
  return problems;
}

// ── the quality judge ────────────────────────────────────────────────────────

// Scoped to quality: a link, a digit, a promised time and an app or a website are already
// decided above, by refusals() and the meaning judge, before a line reaches this judge.
const JUDGE_SYSTEM = judgePrompt('holding-line');

const BROKEN_LINE =
  'Hi! Good news, I checked the schedule and it looks fine 😊. Back in 2 minutes - see https://villagehale.com, ok?';

async function main() {
  assertRunFlags(['--broken', '--env-file', '--max-usd']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('holding-line');
  const cost = makeCost();

  // Before tsImport: a module graph loaded after it resolved without the web paths.
  const meaningJudge = await import(pathToFileURL(MEANING_JUDGE_SRC).href);
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
    // The composer's own loop (holding-line.ts createHoldingLine): a line its gates refuse
    // goes back once with the reasons, and the line that reaches the parent is the first
    // one both gates pass. Every refused attempt is printed below.
    const rejected = [...fixture.rejected];
    const refused = [];
    let body = flatten(BROKEN_LINE);
    let failures = refusals(body);
    for (let attempt = 0; !broken && attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
      const raw = (
        await cachedToolCall({
          tag: attempt === 0 ? `holding-line:${fixture.id}` : `holding-line:${fixture.id}:retry`,
          model,
          lane: subjectLane,
          system: skill.instructions,
          userMessage: holdingLineUserMessage(fixture.language, rejected),
          toolName: 'holding_line',
          toolSchema: LINE_TOOL_SCHEMA,
          toolDescription: 'Return the one line the parent sees while the answer is coming.',
          maxTokens: MAX_TOKENS,
          cachedOnly,
          getClient,
          cost,
        })
      ).value.line;
      body = flatten(String(raw ?? ''));
      failures = refusals(body);
      if (failures.length === 0) {
        failures = await meaningProblems(
          meaningJudge,
          attempt === 0
            ? `holding-line:meaning:${fixture.id}`
            : `holding-line:meaning:${fixture.id}:retry`,
          body,
          { cachedOnly, getClient, cost },
        );
        // Production sends nothing on a judge that gave no verdict; it does not recompose.
        if (failures.includes('judge_failed')) break;
      }
      if (failures.length === 0) break;
      refused.push(`refused at the gate (${failures.join('+')}): "${body}"`);
      rejected.push({ line: body, problems: failures });
    }
    // Skipped in broken mode: the deterministic layer alone must reject the stand-in.
    if (!broken) {
      const verdict = await judge(fixture.id, {
        message: body,
        language: fixture.language,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, body, failures, refused });
  }

  console.log('--- lines ---');
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} "${r.body}"`,
    );
    for (const f of r.refused) console.log(`      ↺ ${f}`);
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
  if (isDryRun()) {
    console.log(dryReportLine('holding-line', [judge.plan]));
    process.exit(0);
  }
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
