// The over-limit (flood) line composer eval (hard rule #8: no LLM mocking). VIL-463.
//
// The subject is the REAL skill (packages/agent/skills/flood-line.md) run through the REAL
// forced-tool-JSON request shape apps/web/lib/channel/router/flood-line.ts builds,
// REPLICATED here as run-holding-line-eval.mjs replicates holding-line.ts. The skill body
// and model routing are imported live, so a skill edit re-keys the cache.
//
// Usage (from apps/worker):
//   node evals/run-flood-line-eval.mjs --dry           # $0, no API: count compose + judge draws, worst-case $
//   node evals/run-flood-line-eval.mjs --broken        # calibration, $0: must FAIL
//   node evals/run-flood-line-eval.mjs --cached-only   # replay only, $0 (misses fail)
//   node --env-file=../../.env evals/run-flood-line-eval.mjs --live   # live, PAID - needs Barton's yes
// Any other flag, or none, exits 2 before the spend cap or a client exists
// (flood-line-flags.mjs).
//
// NOT in CI yet: there is no recorded cache, and recording it is a paid run.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { dryClient, parseFloodLineFlags } from './flood-line-flags.mjs';
import {
  JUDGE_MIN,
  PRICE,
  cacheGet,
  cacheKey,
  cachedToolCall,
  installEvalSpendCap,
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'flood-line.md');

// ── the corpus: draws, since the stage is blind ─────────────────────────────

const MIN_DISTINCT = 3;

const WATCH =
  'Tells the parent, privately, that a lot came in at once and Hale is not answering this one now, and that they can send it again later. No promise Hale will answer this text later, no promise of an answer if they text again (a resend right away gets no reply either), no wait time, no scolding, no mention of anyone else.';

const FIXTURES = [
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `en-direct-draw-${i + 1}`,
    language: 'en',
    inGroup: false,
    countsTowardVariance: true,
    watchFor: WATCH,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `en-group-draw-${i + 1}`,
    language: 'en',
    inGroup: true,
    countsTowardVariance: true,
    watchFor: `${WATCH} They wrote in a group chat; this goes only to them.`,
  })),
  {
    id: 'fr-direct',
    language: 'fr',
    inGroup: false,
    countsTowardVariance: false,
    watchFor: `${WATCH} It must be written in FRENCH.`,
  },
  {
    id: 'null-language',
    language: null,
    inGroup: false,
    countsTowardVariance: false,
    watchFor: `${WATCH} Language is null, so it must be English.`,
  },
];

// ── the composer's request shape and post-processing, replicated ────────────

const LINE_TOOL_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
};

/** Mirrors `floodLineUserMessage` in flood-line.ts. */
function floodLineUserMessage({ language, inGroup }) {
  return JSON.stringify({
    situation: 'many_texts_at_once',
    where_they_wrote: inGroup ? 'a group chat' : 'their own chat with Hale',
    where_this_goes: 'only to them, privately',
    language,
  });
}

// A runaway ceiling only, never a length rule: the writer decides how long the line is.
const MAX_TOKENS = 256;

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts. */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[ {4}]/g, ' '],
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

// The skill's hard facts, checked mechanically (the composer itself only refuses empty).
const LINK_SHAPE = /https?:\/\/|www\./i;

function refusals(body) {
  if (body === '') return ['empty'];
  const found = [];
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (/\d/.test(body)) found.push('carries_number');
  return found;
}

// ── the judge ────────────────────────────────────────────────────────────────

// Scoped to MEANING: every mechanical property is already decided by refusals() above.
const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring the MEANING of ONE private text message Hale sends a',
  'parent who has sent many texts in a short time. Hale is not answering their latest text.',
  'Hale composed it BLIND: it saw only that situation, whether they wrote in a group chat or',
  'their own chat, and the language. Links and digits are ALREADY verified mechanically;',
  "length, sentence count and punctuation are the writer's own. Judge only MEANING.",
  'You are given the message, the language and watchFor. Score 1-5.',
  'A 5 tells them plainly, warmly and in the first person, in the requested language, that a',
  'lot came in at once, Hale is not answering this one now, and they can send it again later.',
  'FACT: for a while every further text from this parent also gets no reply, so a resend right',
  'away gets silence. A LOW score (2 or below) is any of: promising Hale will answer this text',
  'later; promising, by meaning in any wording or language, that Hale will answer or get back',
  'to them if they text again (for example "text again in a bit and I will get back to you");',
  'naming or implying a specific wait or limit; scolding or blaming the parent; mentioning',
  'other people in a group or what was said; support-desk language; third person ("Hale is");',
  'the wrong language; pretending to answer their question. Simply inviting them to send it',
  'again later, with no promise that it will be answered, read or picked up, is TRUE and fine;',
  'do not mark it down. Apply all of this strictly and the same way every time.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN_LINE =
  'Hale is rate-limited: you sent 30 texts! Please wait 60 minutes, I will answer this one then. See https://villagehale.com';

/** Offline token estimate, the same 1-per-3-bytes ratio the other dry runs use. */
const tokensFor = (text) => Math.ceil(text.length / 3);

function worstUsd(model, inTokens, maxOut) {
  const rates = PRICE[model];
  if (!rates) throw new Error(`no price for ${model}`);
  return (inTokens / 1e6) * rates.input + (maxOut / 1e6) * rates.output;
}

/**
 * --dry: no client, no spend cap, no model call. Keys every compose draw exactly as
 * cachedToolCall does and every judge draw exactly as makeJudge does, and prices each
 * miss at its full output ceiling. A judge draw whose compose is not cached has no
 * message to key yet, so it is priced as uncached with a MAX_TOKENS-long message.
 */
async function dryRun({ agent, skill, model, subjectLane, judgeModel }) {
  const judgeMaxOut = judgeModel === agent.HAIKU_MODEL ? 4096 : 8192;
  const draws = { compose: [0, 0], judge: [0, 0] };
  let worst = 0;
  for (const fixture of FIXTURES) {
    const tag = `flood-line:${fixture.id}`;
    const userMessage = floodLineUserMessage(fixture);
    const key = cacheKey(
      tag,
      JSON.stringify({
        model,
        system: skill.instructions,
        userMessage,
        toolName: 'flood_line',
        toolSchema: LINE_TOOL_SCHEMA,
        lane: subjectLane,
      }),
    );
    const cached = await cacheGet(key);
    let judgeMessage;
    if (cached) {
      draws.compose[0] += 1;
      console.log(`DRY  cached    ${tag}`);
      judgeMessage = JSON.stringify({
        message: flatten(String(cached.value?.line ?? '')),
        language: fixture.language,
        watchFor: fixture.watchFor,
      });
    } else {
      const inTokens = tokensFor(skill.instructions + userMessage);
      const usd = worstUsd(model, inTokens, MAX_TOKENS);
      draws.compose[1] += 1;
      worst += usd;
      console.log(
        `DRY  uncached  ${tag}  ~${inTokens} in + ${MAX_TOKENS} max out  worst $${usd.toFixed(5)}`,
      );
    }
    const judgeTag = `flood-line:judge:${fixture.id}`;
    if (judgeMessage !== undefined) {
      const judgeKey = cacheKey(judgeTag, `${judgeModel}\n${JUDGE_SYSTEM}\n${judgeMessage}`);
      if (await cacheGet(judgeKey)) {
        draws.judge[0] += 1;
        console.log(`DRY  cached    ${judgeTag}`);
        continue;
      }
    }
    const message =
      judgeMessage ??
      JSON.stringify({
        message: 'x'.repeat(MAX_TOKENS * 4),
        language: fixture.language,
        watchFor: fixture.watchFor,
      });
    const inTokens = tokensFor(JUDGE_SYSTEM + message);
    const usd = worstUsd(judgeModel, inTokens, judgeMaxOut);
    draws.judge[1] += 1;
    worst += usd;
    console.log(
      `DRY  uncached  ${judgeTag}  ~${inTokens} in + ${judgeMaxOut} max out  worst $${usd.toFixed(5)}`,
    );
  }
  const [cc, cu] = draws.compose;
  const [jc, ju] = draws.judge;
  console.log(
    `DRY summary | compose draws ${cc + cu} (cached ${cc}, uncached ${cu}) | judge draws ${jc + ju} (cached ${jc}, uncached ${ju}) worst $${worst.toFixed(5)}`,
  );
  console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
}

async function main() {
  let mode;
  try {
    mode = parseFloodLineFlags(process.argv.slice(2));
  } catch (err) {
    console.error(`flood-line eval: ${err.message}`);
    process.exit(2);
  }
  if (mode === 'dry') {
    const agent = await tsImport(AGENT_SRC, import.meta.url);
    const skill = await agent.loadSkill(SKILL_PATH);
    const model = agent.pickModel(skill.meta.task);
    const subjectLane = agent.pickLane(skill.meta.task);
    const judgeModel = await readJudgeModel();
    console.log(`flood-line eval | mode=dry (no API calls) | compose=${model} judge=${judgeModel}`);
    await dryRun({ agent, skill, model, subjectLane, judgeModel, getClient: dryClient });
    return;
  }
  const broken = mode === 'broken';
  const cachedOnly = mode === 'cached-only';
  installEvalSpendCap();
  // Belt and braces: only --live ever gets a real client.
  const getClient = mode === 'live' ? lazyAnthropic('flood-line') : dryClient;
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const subjectLane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'flood-line', cachedOnly, getClient, cost);

  console.log(
    `flood-line eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${FIXTURES.length} draws\n`);

  const results = [];
  for (const fixture of FIXTURES) {
    const raw = broken
      ? BROKEN_LINE
      : (
          await cachedToolCall({
            tag: `flood-line:${fixture.id}`,
            model,
            lane: subjectLane,
            system: skill.instructions,
            userMessage: floodLineUserMessage(fixture),
            toolName: 'flood_line',
            toolSchema: LINE_TOOL_SCHEMA,
            toolDescription: 'Return the one private line the parent gets.',
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
  console.error('flood-line eval harness error:', err);
  process.exit(2);
});
