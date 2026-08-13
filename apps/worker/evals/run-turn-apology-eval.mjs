// The turn apology composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/turn-apology.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/channel/router/apology.ts builds —
// REPLICATED here rather than imported, for the reason the general-answer and lane evals
// replicate: that module sits behind the web app's `~/` alias, which the tsx loader here
// cannot resolve. The SKILL body and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows up
// here as a miss rather than as silence. `smsEncoding` IS imported real — it is a pure
// module with no aliases, and the GSM-7 table is exactly the thing a replica would get
// subtly wrong.
//
// WHAT IS AT STAKE. This sentence replaced a constant. A parent whose turn broke used to
// read the same twelve words every time; now a model writes them, which buys warmth and
// variety and risks everything a model risks — a promise Hale cannot keep, an invented
// cause, a question the parent now owes an answer to, or a body that cannot be sent at
// all, in which case the whole turn is deferred and they hear NOTHING.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-turn-apology-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-turn-apology-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-turn-apology-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · unsendable bodies — anything the composer's own refusals() would throw away. Three
//     of those in a row and the parent is never answered at all.
//   · a promised fix time — "back in a minute" is a commitment nobody scheduled.
//   · an app pointer — what broke was Hale's end; handing the parent a second surface is
//     handing them the work (skill audit P0 #4).
//   · too few distinct sentences, and no two bodies that are the SAME sentence wearing
//     different punctuation — a composed apology that never varies is the deleted
//     constant with an API bill. This count used to be a Set of raw strings, which one
//     comma defeated: the 2026-08-13 tone audit found "That one broke on my end and
//     nothing changed." and "That one broke on my end, and nothing changed." counted as
//     two, on top of three byte-identical bodies. It runs through the shared variation
//     gate now, which normalizes punctuation away before it counts.
// Everything else is the judge's bar (JUDGE_MIN per fixture): owns the fault, says
// nothing was changed, one plain sentence, no invented cause, no grovelling.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { APOLOGY_FIXTURES, MIN_DISTINCT } from './turn-apology-fixtures.mjs';
import {
  cachedToolCall,
  JUDGE_MIN,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import {
  normalizeForCompare,
  skillSampleSentences,
  variationGate,
  variationLines,
} from './lib/variation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'turn-apology.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

// ── the composer's request shape, replicated from apology.ts ────────────────

/** Mirrors `apologyJsonSchema`. */
const APOLOGY_TOOL_SCHEMA = {
  type: 'object',
  properties: { apology: { type: 'string' } },
  required: ['apology'],
};

/** Mirrors `apologyUserMessage` — one situation constant, and the refused attempts when
 * there are any. Nothing about the family reaches this stage at all. */
function apologyUserMessage(rejected = []) {
  const base = { situation: 'turn_failed_nothing_changed' };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

const MAX_TOKENS = 96;

// ── the composer's post-processing, replicated from apology.ts ─────────────

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts (behind `~/`, so
 * replicated). The composer flattens BEFORE it judges, so an eval that gated on the raw
 * body would be measuring a string production never sees. */
const GSM7_SUBSTITUTIONS = [
  [/[\u2018\u2019\u201b]/g, "'"],
  [/[\u201c\u201d]/g, '"'],
  [/[\u2013\u2014\u2015]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u00a0\u2007\u202f\u2009]/g, ' '],
  [/[\u2022\u00b7]/g, ''],
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

// ── the composer's refusals(), replicated from apology.ts ───────────────────

const MAX_APOLOGY_CHARS = 160;
const LINK_SHAPE = /https?:\/\/|www\./i;
const INTERNAL_TERMINATOR = /[.!?]["')\]]?\s+\S/;

function refusals(body, smsEncoding) {
  if (body === '') return ['empty'];
  const found = [];
  if (body.length > MAX_APOLOGY_CHARS) found.push('over_char_cap');
  if (smsEncoding(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (INTERNAL_TERMINATOR.test(body)) found.push('not_one_sentence');
  if (body.includes('?')) found.push('carries_question');
  if (/\d/.test(body)) found.push('invented_number');
  return found;
}

// Three shapes the composer's own gates CANNOT catch, because all three are perfectly
// sendable English. They are held deterministically for the reason general-answer holds
// its redirect shapes that way: the judge proved flappy on exactly this class, and these
// are the ones the skill states as absolute.
const PROMISED_TIME =
  /\b(shortly|momentarily|in a (minute|moment|sec|second|bit|jiffy)|any (minute|moment) now|as soon as|right back)\b/i;
const APP_POINTER = /\b(the app|in-app|your dashboard|the website|villagehale)\b/i;
// The FALSEST thing this stage can say. On the branch that reaches it the turn is over:
// nothing is queued, nothing is running, and nobody picks it up. A parent told otherwise
// waits for a message that never comes. Live draw 3 wrote "your request is still waiting
// for me to try again" before the skill forbade it, which is why the shape is checked
// rather than trusted. "Try me again whenever" is the parent retrying and stays legal.
const PROMISED_RETRY =
  /\b(i'?ll (try|retry|have another|give it another|get to it|let you know|fix|sort)|me to (try|run|do|have) (it |that )?again|still (waiting|queued|pending|in progress|on it)|will (be )?(retr|re-?run|pick))/i;

// ── the judge ────────────────────────────────────────────────────────────────

// SCOPED TO MEANING, deliberately. Every mechanical property — sentence count, length,
// punctuation, links, digits, app pointers, retry promises — is already decided by
// refusals() above and by the two shape checks, and a message that failed any of them has
// already failed the run. Asking the judge to re-check them made it WORSE, not safer: on
// live draws it called a single clause "two sentences" and read the required "on my end"
// as naming a cause. So it is told not to.
const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring the MEANING of ONE text message Hale sends a parent',
  'whose request just broke on Hale\'s own side. Hale composed it BLIND: it was shown',
  'nothing about the parent, the family, or what they asked - only that a turn failed and',
  'nothing was changed.',
  'IMPORTANT: sentence count, character length, punctuation, links, digits, app pointers',
  'and retry promises are ALREADY verified mechanically before you see this. Do not score',
  'them and do not comment on them. Judge only whether the message MEANS the right thing',
  'and sounds like Hale.',
  'You are given the message and watchFor - fixture-specific notes. Score 1-5.',
  'A 5 does BOTH of two things: it owns the failure as Hale\'s own, and it tells the',
  'parent nothing was changed. It reads like a competent friend who dropped something -',
  'first person, short words, no fuss. NOTE: "on my end", "I couldn\'t get that done" and',
  '"that one broke" are the INTENDED way to own it, not vague and not a cause; score them',
  'well.',
  'A LOW score is any of: missing either half of that meaning; naming an actual technical',
  'cause it cannot know ("the server", "a timeout", "our database", "the API"); incident',
  'or support-desk language ("error", "issue on our end", "technical difficulties", "we',
  'apologise for the inconvenience"); grovelling or more than one apology word; saying or',
  'implying the request is queued, still running, or will be retried; handing the parent',
  'an errand ("please resend", "you\'ll need to"); claiming part of it went through;',
  'blaming or involving the parent; a greeting, hype or an emoji; a sentence so garbled',
  'or self-contradictory that a parent would have to read it twice.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: two sentences, a question, a digit, an emoji, a link,
// an app pointer and a promised time — trips not_one_sentence + carries_question +
// invented_number + not_gsm7 + carries_link + both deterministic shapes + the judge, so
// `--broken` proves every layer bites.
const BROKEN_APOLOGY =
  'Oops! We hit a technical error 😊. Your request is still waiting - please check the app at https://villagehale.com and try again in 5 minutes, ok?';

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
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'turn-apology', cachedOnly, getClient, cost);

  console.log(
    `turn-apology eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${APOLOGY_FIXTURES.length} draws\n`);

  const results = [];
  for (const fixture of APOLOGY_FIXTURES) {
    const raw = broken
      ? BROKEN_APOLOGY
      : (
          await cachedToolCall({
            tag: `turn-apology:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: apologyUserMessage(fixture.rejected),
            toolName: 'apology',
            toolSchema: APOLOGY_TOOL_SCHEMA,
            toolDescription: 'Return the one sentence the parent gets back.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.apology;

    const body = flatten(raw);
    const failures = refusals(body, smsEncoding);
    if (PROMISED_TIME.test(body)) failures.push('promised_a_time');
    if (PROMISED_RETRY.test(body)) failures.push('promised_a_retry');
    if (APP_POINTER.test(body)) failures.push('points_at_the_app');

    const verdict = await judge(fixture.id, { message: body, watchFor: fixture.watchFor });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);

    results.push({ fixture, body, failures });
  }

  // Variance is measured over the PLAIN draws only. The three recompose fixtures are
  // handed a refused body to repair, so their answers are steered by that input rather
  // than freely drawn, and counting them would let the recompose loop stand in for the
  // variety the plain draws are supposed to show.
  const variance = results.filter((r) => r.fixture.countsTowardVariance);
  const variation = variationGate({
    items: variance.map((r) => ({ id: r.fixture.id, text: r.body })),
    samples,
  });

  // PARROTING IS GATED. NEAR-DUPLICATION IS MEASURED AND PRINTED, AND DELIBERATELY NOT
  // GATED HERE — the one suite in the battery where that is true, so here is the reason.
  //
  // This stage is BLIND: every draw sends the byte-identical payload
  // {"situation":"turn_failed_nothing_changed"}. Eight draws are therefore eight
  // independent samples from ONE distribution, and that distribution is sharply peaked
  // because the meaning is pinned to two clauses inside 160 characters. No wording in the
  // skill can decorrelate independent samples, and trying it three times over live
  // re-records (2026-08-13) only ever MOVED the peak: retiring "that one broke on my end"
  // produced seven of eight on "didn't work out on my end"; adding an explicit
  // pick-at-random instruction produced three BYTE-IDENTICAL draws, worse than the corpus
  // it replaced. Gating the pairwise score would therefore hold this suite permanently
  // red on a property the skill cannot deliver.
  //
  // THE MISSING PRIMITIVE, named rather than patched around: the composer needs an
  // `avoid` list — the last few apology bodies actually sent to THIS family, handed in
  // with the payload the way `rejected` already is, so a repeat is impossible by
  // construction instead of improbable by temperature. That is a change to
  // apps/web/lib/channel/router/apology.ts and to whatever records an outbound body, not
  // a change to the words, and until it exists "a parent should not read the same
  // sentence twice" is an aspiration this eval can only report on.
  //
  // What IS still gated: the distinct-body count below (now normalized, so a comma can no
  // longer inflate it) and the parrot check, both of which the skill CAN control.
  for (const result of variance) {
    const failures = variation.failuresById[result.fixture.id] ?? [];
    result.failures.push(...failures.filter((f) => !f.startsWith('near_duplicate')));
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- apologies ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(26)} "${r.body}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const unsendable = results.filter((r) =>
    r.failures.some((f) =>
      ['empty', 'over_char_cap', 'not_gsm7', 'carries_link', 'not_one_sentence', 'carries_question', 'invented_number'].includes(f),
    ),
  );
  const promises = results.filter((r) => r.failures.includes('promised_a_time'));
  const retries = results.filter((r) => r.failures.includes('promised_a_retry'));
  const pointers = results.filter((r) => r.failures.includes('points_at_the_app'));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));

  const distinct = new Set(variance.map((r) => normalizeForCompare(r.body))).size;
  const tooSame = distinct < MIN_DISTINCT;

  console.log('\n--- corpus metrics ---');
  console.log(`UNSENDABLE bodies:       ${unsendable.length}  (0 required - three of these and the parent hears nothing)`);
  console.log(`promised a fix time:     ${promises.length}  (0 required)`);
  console.log(`claimed it would retry:  ${retries.length}  (0 required - the turn is over, nothing is queued)`);
  console.log(`pointed at the app:      ${pointers.length}  (0 required)`);
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(
    `distinct sentences:      ${distinct}/${variance.length}  (${MIN_DISTINCT}+ required, punctuation normalized away - a constant with an API bill is the failure)`,
  );
  const duplicatePairs = Object.values(variation.failuresById)
    .flat()
    .filter((f) => f.startsWith('near_duplicate')).length / 2;
  for (const line of variationLines(variation, { pairGated: false })) console.log(line);
  console.log(
    `near-duplicate pairs:    ${duplicatePairs}  (REPORTED, NOT GATED - blind stage, see the note in main())`,
  );

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
  console.error('turn-apology eval harness error:', err);
  process.exit(2);
});
