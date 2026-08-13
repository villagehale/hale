// The follow-up ask · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/followup-voice.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/channel/followup/voice.ts builds —
// REPLICATED here rather than imported, for the reason the lane, intake and general-answer
// evals replicate: that module sits behind the web app's `~/` alias, which the tsx loader
// here cannot resolve. The SKILL body and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows up
// here as a miss rather than as silence. `smsEncoding` IS imported real —
// apps/web/lib/channel/sms-segments.ts is a pure module with no aliases, and the GSM-7
// table is exactly the thing a replica would get subtly wrong.
//
// WHY THE BAR IS HIGHER HERE THAN FOR THE GENERAL ANSWER. That stage has a fixed deflect
// line to fall back on; this one has NOTHING. Founder doctrine 2026-08-12: no preset
// message bodies. A body that fails the gates is composed again with the failure fed
// back, and if three attempts run out the family hears nothing at all. So "unsendable"
// here is not a degraded message, it is a missing one.
//
// What is NOT tested here: the recompose/defer machinery and the sweep's reaction to it
// (apps/web/lib/channel/followup/voice.test.ts, run.test.ts — deterministic), and the
// told-anywhere screen (screen.test.ts). This eval is only about the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-followup-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-followup-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-followup-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · unsendable asks — anything the composer's own refusals() would refuse (empty / over
//     160 / non-GSM-7 / a link / not exactly one question / not naming the activity / a
//     number it was never given). Every one of these is a text the family never gets.
//   · forbidden-pattern hits — a pronoun or a relationship word in an ask composed from a
//     title alone is a fact about a child that the model invented (rule #1).
//   · parroted samples — an ask that matches one of the skill's own example lines word for
//     word. The corpus's first live run produced "How was Swim class? No pressure to
//     reply." for three of four activity fixtures, byte-identical to the single example
//     the skill then carried: a pipeline that is LLM-composed and a MESSAGE that is a
//     preset body, which is the doctrine's letter without its purpose. The skill now shows
//     a range and forbids reuse; this gate is what keeps that true.
//   · one-template corpus — every activity ask opening the same way. A parent gets these
//     for months, and the variation the model is here to provide has to be visible across
//     the corpus, not just absent from any single line.
// Everything else is the judge's bar (JUDGE_MIN per fixture): one warm question about the
// named thing, pressure taken off, nothing assumed, nothing offered, nothing else.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { FOLLOWUP_VOICE_FIXTURES } from './followup-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'followup-voice.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

/** How many distinct openings the activity asks must show between them. Two is a low bar
 * on purpose — it catches a corpus that has collapsed onto one template without pretending
 * to measure style. */
const MIN_DISTINCT_OPENERS = 2;

/** The skill's own blockquoted example lines. Read off the file rather than restated, so
 * an example added later is covered without anyone remembering to add it here. */
async function skillSampleLines() {
  const source = await readFile(SKILL_PATH, 'utf8');
  return source
    .split('\n')
    .filter((line) => line.startsWith('> '))
    .map((line) => normalizeForCompare(line.slice(2)));
}

function normalizeForCompare(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/** The first three words, as the cheap stand-in for "how this message opens". */
function opener(body) {
  return normalizeForCompare(body).split(' ').slice(0, 3).join(' ');
}

// ── the composer's request shape, replicated from voice.ts ──────────────────

/** Mirrors `askJsonSchema` in voice.ts. */
const ASK_TOOL_SCHEMA = {
  type: 'object',
  properties: { ask: { type: 'string' } },
  required: ['ask'],
};

/** Mirrors `followupVoiceUserMessage` in voice.ts — the kind, the title if there is one,
 * and any refused attempts. Nothing about the family can ride in on this shape. */
function followupVoiceUserMessage(request, rejected = []) {
  const base =
    request.kind === 'activity'
      ? { kind: 'activity', activity: request.activity }
      : { kind: 'intro' };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

const MAX_TOKENS = 128;

// ── the composer's refusals(), replicated from voice.ts ─────────────────────

const MAX_ASK_CHARS = 160;
const LINK_SHAPE = /https?:\/\/|www\./i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function refusals(body, request) {
  const found = [];
  if (body === '') return ['empty'];
  if (body.length > MAX_ASK_CHARS) found.push('over_char_cap');
  if (smsEncodingRef(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if ((body.match(/\?/g) ?? []).length !== 1) found.push('not_one_question');

  let withoutSubject = body;
  if (request.kind === 'activity') {
    if (!body.toLowerCase().includes(request.activity.toLowerCase())) found.push('subject_missing');
    withoutSubject = body.replace(new RegExp(escapeRegExp(request.activity), 'gi'), ' ');
  }
  if (/\d/.test(withoutSubject)) found.push('invented_number');
  return found;
}

/** Bound in main() once the real module is loaded — refusals() has to reach the same
 * GSM-7 table the segment counter bills on, not a copy of it. */
let smsEncodingRef = () => 'gsm7';

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts (behind `~/`, so replicated). */
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

// ── the judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sends a parent to check back on',
  'something it set up days ago - an introduction to another family, or an activity it put',
  'on their calendar. Hale composed this BLIND: for an activity it was shown the title and',
  'nothing else, and for an introduction it was shown nothing at all. No family, no',
  'children, no dates, no tools.',
  'You are given the request it was answering, the message, and watchFor - fixture-specific',
  'notes on what right and wrong look like here. Score 1-5.',
  'A 5 is a friend who happened to remember, texting: ONE warm question about how the named',
  'thing went, the pressure explicitly taken off ("no pressure", "no need to reply", "even a',
  'word is fine"), and nothing else at all. Short. Plain. First person.',
  'A LOW score is any of: assuming it happened or that it went well ("hope swim was fun!");',
  'a second question, or a question plus a request; offering to do anything next (find',
  'another one, book the next session, look something up); any invented specific - a time,',
  'a date, a place, a price, or ANYTHING about a child including age, pronoun or',
  'relationship; naming or describing the other household in the introduction case;',
  'greeting, hype, exclamation marks, emoji, "just checking in!"; pointing at an app or a',
  'link; padding after the question; more than about two short sentences.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: hype, a second question, an invented time, an emoji, a
// link, an offer to do something next, and no mention of the activity by name — trips
// not_gsm7 + carries_link + not_one_question + subject_missing + invented_number + the
// judge, so `--broken` proves every layer bites.
const BROKEN_ASK =
  'Hi there! Hope the 4pm session was amazing 😊 How did she do? Want me to book the next one? ' +
  'See www.example.com for options.';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsEncoding } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  smsEncodingRef = smsEncoding;
  const skill = await agent.loadSkill(SKILL_PATH);
  const samples = await skillSampleLines();
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'followup-voice', cachedOnly, getClient, cost);

  console.log(
    `followup-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${FOLLOWUP_VOICE_FIXTURES.length} asks\n`);

  const results = [];
  for (const fixture of FOLLOWUP_VOICE_FIXTURES) {
    const userMessage = followupVoiceUserMessage(fixture.request, fixture.rejected ?? []);
    const raw = broken
      ? BROKEN_ASK
      : (
          await cachedToolCall({
            tag: `followup-voice:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage,
            toolName: 'ask',
            toolSchema: ASK_TOOL_SCHEMA,
            toolDescription: 'Return the one short check-in question.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.ask;

    const body = flatten(raw);
    const failures = refusals(body, fixture.request);
    for (const pattern of fixture.forbiddenPatterns ?? []) {
      if (pattern.test(body)) failures.push(`forbidden:${pattern.source}`);
    }
    if (samples.includes(normalizeForCompare(body))) failures.push('parrots_sample');

    const verdict = await judge(fixture.id, {
      request: userMessage,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);

    results.push({ fixture, body, failures });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- asks ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(24)} "${r.body.slice(0, 90)}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const GATE_NAMES = [
    'empty',
    'over_char_cap',
    'not_gsm7',
    'carries_link',
    'not_one_question',
    'subject_missing',
    'invented_number',
  ];
  const unsendable = results.filter((r) => r.failures.some((f) => GATE_NAMES.includes(f)));
  const inventedChild = results.filter((r) => r.failures.some((f) => f.startsWith('forbidden:')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const parroted = results.filter((r) => r.failures.includes('parrots_sample'));
  const activityOpeners = new Set(
    results.filter((r) => r.fixture.request.kind === 'activity').map((r) => opener(r.body)),
  );

  console.log('\n--- corpus metrics ---');
  console.log(
    `UNSENDABLE ASKS:         ${unsendable.length}  (0 required - there is no fallback line, so the family gets nothing)`,
  );
  console.log(`invented child facts:    ${inventedChild.length}  (0 required - rule #1)`);
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(
    `parroted skill samples:  ${parroted.length}  (0 required - a stored string with extra steps)`,
  );
  console.log(
    `distinct activity opens: ${activityOpeners.size}  (>= ${MIN_DISTINCT_OPENERS} required - one template is a preset body)`,
  );

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    results.every((r) => r.failures.length === 0) && activityOpeners.size >= MIN_DISTINCT_OPENERS;

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
  console.error('followup-voice eval harness error:', err);
  process.exit(2);
});
