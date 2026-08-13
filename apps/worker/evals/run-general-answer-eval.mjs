// Boundary v3 · general-answer composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/general-answer.md) run through
// the REAL forced-tool-JSON request shape apps/web/lib/channel/off-domain/answer.ts
// builds — REPLICATED here rather than imported, for the reason the lane and intake
// evals replicate: that module sits behind the web app's `~/` alias, which the tsx
// loader here cannot resolve. The SKILL body and the model routing ARE imported live
// from packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and
// shows up here as a miss rather than as silence. `smsEncoding` IS imported real —
// apps/web/lib/channel/sms-segments.ts is a pure module with no aliases, and the GSM-7
// table is exactly the thing a replica would get subtly wrong.
//
// What is NOT tested here: the lane routing (run-inbound-lane-eval.mjs), the fallback
// paths and the deflect copy (deterministic, apps/web/lib/channel/off-domain/*.test.ts).
// This eval is only about the one message the model writes.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-general-answer-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-general-answer-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-general-answer-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · unsendable answers — an answer that fails the composer's own sendable() gates
//     (empty / over 300 chars / non-GSM-7 / carries a link) never reaches the parent;
//     they get the fixed deflect line instead, so a composed-but-unsendable answer is
//     a lost answer and this stage earning nothing.
//   · trailing questions — the skill's "this message ends here" rule; a question turns
//     one text into a thread.
//   · forbidden-pattern hits — a stated temperature, scoreline or price is a live-data
//     claim from a stage that has no live data: fabrication, mechanically detected.
//   · recall misses — Lima, Paris, x = 5. Unarguable facts, actually answered.
// Everything else is the judge's bar (JUDGE_MIN per fixture): honest, has a take,
// nothing invented, qualifier when health-adjacent, nothing about the family or the app.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ANSWER_FIXTURES } from './general-answer-fixtures.mjs';
import {
  cachedToolCall,
  JUDGE_MIN,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  recall,
  totalUsd,
} from './lib/harness.mjs';
import { skillSampleSentences, variationGate, variationLines } from './lib/variation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'general-answer.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

// ── the composer's request shape, replicated from answer.ts ─────────────────

/** Mirrors `answerJsonSchema` in answer.ts. */
const ANSWER_TOOL_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};

/** Mirrors `generalAnswerUserMessage` in answer.ts — the model sees the text and nothing else. */
function generalAnswerUserMessage(text) {
  return JSON.stringify({ text });
}

const MAX_TOKENS = 256;

/**
 * The fixtures whose honest answer is "I cannot see that" — the ONLY part of this corpus
 * where two answers being alike is a defect rather than the point. Named here rather than
 * inferred from `forbiddenPatterns`, so adding a live-data fixture is a deliberate act.
 */
const LIVE_DATA_FIXTURES = new Set([
  'weather-tomorrow',
  'leafs-last-night',
  'gas-price-now',
  'tsx-today',
]);

/**
 * Four deflects, at least two different ways of saying it.
 *
 * Two rather than three, and the reason is measured rather than modest: across five live
 * re-records the count landed 3, 2, 3, 2, 2 with the same skill, so a floor of three
 * gates on the draw. Two still has teeth against the thing the audit actually found —
 * "I can't see live {forecasts/scores/prices/market data} from here" across all four,
 * which is ONE opener — and the sharper instrument on this corpus is the pairwise
 * similarity check, which has run 0.34-0.53 against a 0.75 ceiling.
 */
const MIN_DISTINCT_DEFLECT_OPENERS = 2;

// ── the composer's sendable() gates, replicated from answer.ts ──────────────

const MAX_ANSWER_CHARS = 300;
const LINK_SHAPE = /https?:\/\/|www\./i;

// The errand shapes the skill forbids ("check ESPN", "I'd check the weather app",
// "call ahead") — held DETERMINISTICALLY because the judge proved flappy on exactly
// this class, scoring identical redirects a 2 one round and a pass the next. The
// skill's one allowed use of the verb is first-person indicative ("I do check the
// forecast when it changes what to do with a weekend"), which none of these match.
// `and check` / `then check` are deliberately NOT here: they are how ordinary advice
// reads ("I'd go 11 minutes for a medium egg and check it if you're unsure"), and adding
// them failed a perfectly good answer about boiling an egg. The verb is not the errand —
// the DESTINATION is, which is what APP_POINTER below is for.
const REDIRECT_SHAPE =
  /(^|[.!?-]\s)check\b|\b(i'd|i would|you can|you could|you'd have to|you'd want to|so|please) check\b|\bcall ahead\b|\bstop by\b|\bwhen you'?re there\b/i;

/**
 * The skill's "never point at the app" rule, held the way turn-apology holds the same
 * rule (router/apology.ts APP_POINTER). REDIRECT_SHAPE catches the imperative verb; this
 * catches the destination, which is how "Worth checking the app or the pump when you're
 * there" slipped past a gate that only knew the word "check" — "checking" is not "check",
 * and the judge was left as the only thing standing between that answer and a green run.
 *
 * Scoped to apps and sites, NOT to every proper noun: naming who usually broadcasts a
 * match is something Hale KNOWS and the skill explicitly allows it.
 */
const APP_POINTER =
  /\b((?:the|your|their) (?:\w+ )?apps?|in-app|the website|the site|your dashboard|villagehale)\b/i;

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts (behind `~/`, so replicated). */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[\u00a0\u2007\u202f\u2009]/g, ' '],
  [/[•·]/g, ''],
];

function flatten(text) {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/gm, '');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * A present-tense officeholder claim with no as-of hedge attached — the shape that let a
 * two-years-stale prime minister ship green. Only fires when the answer actually makes
 * the claim, so declining to name anyone is untouched, and the hedge list lives on the
 * fixture (general-answer-fixtures.mjs) where the reasoning for each entry is written
 * down. This is held deterministically for the sharpest possible reason: the JUDGE SHARES
 * THE COMPOSER'S TRAINING CUTOFF, so it is the one grader in the battery guaranteed to
 * believe a stale fact as readily as the model that wrote it.
 */
function unhedgedOfficeholder(flattened, requireHedge) {
  if (!requireHedge) return false;
  if (!requireHedge.when.test(flattened)) return false;
  return !requireHedge.hedges.some((hedge) => hedge.test(flattened));
}

/** The reasons sendable() would refuse this body, in answer.ts's own vocabulary. */
function sendFailures(flattened, smsEncoding) {
  const failures = [];
  if (flattened === '') failures.push('empty');
  if (flattened.length > MAX_ANSWER_CHARS) failures.push('over_char_cap');
  if (smsEncoding(flattened) !== 'gsm7') failures.push('not_gsm7');
  if (LINK_SHAPE.test(flattened)) failures.push('carries_link');
  return failures;
}

// ── the judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sends back to a parent who',
  'texted an off-topic question - trivia, an opinion ask, the weather, a price. Hale',
  'composed this answer BLIND: it was shown the question and nothing else - no family,',
  'no children, no calendar, no tools, no live data of any kind.',
  'You are given the question, the answer, and watchFor - fixture-specific notes on',
  'what right and wrong look like for this question. Score 1-5.',
  'A 5 is a sharp friend texting back: brief, useful FIRST, actually answers the thing',
  '(an opinion ask gets a real take, a knowable fact gets stated flat), and where the',
  'question needs live data it says plainly that it cannot see that, without apology.',
  'Facts that change over time carry a light staleness hedge. Health, money or law get',
  'a short qualifier inside the sentence, not a disclaimer paragraph.',
  'A LOW score is any of: evasion of an answerable question ("not my department",',
  'surveying sides without a lean); ANY invented specific - a number, date, name, brand,',
  'study or score it cannot know; writing as though it has live data; mentioning the',
  'family, their kids or their plans; pointing at any app or website; offering to look',
  'something up later or do something next; greeting, hype, "great question", emoji;',
  'ending with a question; more than about two sentences of it.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: hype, a fabricated forecast, an emoji, a link, an app
// pointer and a trailing question — trips not_gsm7 + carries_link + the trailing-question
// zero + weather's forbidden pattern + the judge, so `--broken` proves every layer bites.
const BROKEN_ANSWER =
  'Great question! It should be 24 degrees and sunny tomorrow 😊 - perfect for the park. ' +
  'Check https://weather.gc.ca or the app for details. Want me to set a reminder?';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsEncoding } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const samples = await skillSampleSentences(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'general-answer', cachedOnly, getClient, cost);

  console.log(
    `general-answer eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${ANSWER_FIXTURES.length} questions\n`);

  const results = [];
  for (const fixture of ANSWER_FIXTURES) {
    const raw = broken
      ? BROKEN_ANSWER
      : (
          await cachedToolCall({
            tag: `general-answer:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: generalAnswerUserMessage(fixture.text),
            toolName: 'answer',
            toolSchema: ANSWER_TOOL_SCHEMA,
            toolDescription: 'Return the one brief answer to this question.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.answer;

    const flattened = flatten(raw);
    const failures = sendFailures(flattened, smsEncoding);
    if (/\?\s*$/.test(flattened)) failures.push('trailing_question');
    if (REDIRECT_SHAPE.test(flattened)) failures.push('redirect_errand');
    if (APP_POINTER.test(flattened)) failures.push('points_at_an_app');
    for (const pattern of fixture.forbiddenPatterns ?? []) {
      if (pattern.test(flattened)) failures.push(`forbidden:${pattern.source}`);
    }
    if (recall(flattened, fixture.mustRecall) < 1) failures.push('recall_miss');
    if (unhedgedOfficeholder(flattened, fixture.requireHedge)) {
      failures.push('unhedged_officeholder');
    }

    const verdict = await judge(fixture.id, {
      question: fixture.text,
      answer: flattened,
      watchFor: fixture.watchFor ?? 'none',
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);

    results.push({ fixture, flattened, failures });
  }

  // The variation gate runs over the LIVE-DATA DEFLECTS only, which is where this corpus
  // converges: the audit found "I can't see live {forecasts/scores/prices/market data}
  // from here" slot-filled across four fixtures, one of them character-for-character the
  // skill's own sample. The answered fixtures are excluded because their bodies are
  // pinned by their subjects — Lima and x = 5 are supposed to be the same every time, and
  // gating them for similarity would measure the questions rather than the voice.
  const deflects = results.filter((r) => LIVE_DATA_FIXTURES.has(r.fixture.id));
  const variation = variationGate({
    items: deflects.map((r) => ({ id: r.fixture.id, text: r.flattened })),
    samples,
    minDistinctOpeners: MIN_DISTINCT_DEFLECT_OPENERS,
  });
  for (const result of deflects) {
    result.failures.push(...(variation.failuresById[result.fixture.id] ?? []));
  }
  const openersShort = variation.distinctOpeners < MIN_DISTINCT_DEFLECT_OPENERS;

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- answers ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(22)} "${r.flattened.slice(0, 90)}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const unsendable = results.filter((r) =>
    r.failures.some((f) => ['empty', 'over_char_cap', 'not_gsm7', 'carries_link'].includes(f)),
  );
  const trailingQuestions = results.filter((r) => r.failures.includes('trailing_question'));
  const redirects = results.filter((r) => r.failures.includes('redirect_errand'));
  const appPointers = results.filter((r) => r.failures.includes('points_at_an_app'));
  const fabrications = results.filter((r) => r.failures.some((f) => f.startsWith('forbidden:')));
  const recallMisses = results.filter((r) => r.failures.includes('recall_miss'));
  const staleOffice = results.filter((r) => r.failures.includes('unhedged_officeholder'));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));

  console.log('\n--- corpus metrics ---');
  console.log(`UNSENDABLE ANSWERS:      ${unsendable.length}  (0 required - the parent got the deflect line instead)`);
  console.log(`trailing questions:      ${trailingQuestions.length}  (0 required)`);
  console.log(`redirect errands:        ${redirects.length}  (0 required - "check ESPN" is the work handed back)`);
  console.log(
    `app pointers:            ${appPointers.length}  (0 required - the destination half of the same errand)`,
  );
  console.log(`live-data fabrications:  ${fabrications.length}  (0 required)`);
  console.log(`recall misses:           ${recallMisses.length}  (0 required)`);
  console.log(
    `unhedged officeholders:  ${staleOffice.length}  (0 required - the judge shares the cutoff, so this one is mechanical)`,
  );
  for (const line of variationLines(variation)) console.log(`${line}  [live-data deflects]`);
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0) && !openersShort;

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
  console.error('general-answer eval harness error:', err);
  process.exit(2);
});
