// Onboarding script v2 · intake-voice ACK eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/intake-voice.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/channel/intake/intake-voice.ts builds
// — REPLICATED here rather than imported, for the same reason the intake/radar/sentinel
// evals replicate: the web modules sit behind the `~/` alias, which the tsx loader here
// cannot resolve. The SKILL body and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows up
// here immediately.
//
// What is NOT tested here: the fallback ladder (voice_unavailable / skill_unavailable /
// model_failed / unusable) and the guards themselves. Those are pure code with their own
// vitest suite (apps/web/lib/channel/intake/intake-voice.test.ts) and no model runs in
// them. This eval is only about the one thing a model does in this turn: acknowledging a
// parent warmly without inventing anything and without asking a question.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-intake-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-intake-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-intake-voice-eval.mjs --cached-only                    # CI: replay only
//
// Calibrated BOTH directions: the real cached model clears every gate; the --broken
// stand-in (an ack that invents a venue and an age for a child who has neither, asks its
// own question, and rambles past the ceiling) fails the fabrication gate, the question
// gate, the length gate AND the tone judge — proving the gates have teeth.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readModelIds,
  totalUsd,
} from './lib/harness.mjs';
import { INTAKE_VOICE_FIXTURES, MAX_ACK_CHARS } from './intake-voice-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'intake-voice.md');

const MAX_TOKENS = 200;

/**
 * The voice floor for THIS suite is a CORPUS MEAN of 3, not the shared per-fixture
 * JUDGE_MIN of 4, and both departures are measured rather than convenient.
 *
 * This turn is capped at 160 characters, may state no fact the parent did not just give,
 * and is followed immediately by a question. When a parent texts "ben 2" there is nothing
 * further Hale can honestly say, so the ceiling on "warmth" is set by the INPUT, not by
 * the model. Run live at both tiers, the Sonnet judge consistently scores those
 * input-poor acks 3 ("Got it - Nora is 3.", "Got it - Zoe is 5 and Andre is 7.") while
 * scoring input-rich ones 5 ("Got it - Maya just turned 4 and Leo is your baby.") — at
 * Haiku AND at Sonnet. A 4 floor would therefore gate on how much the parent typed.
 *
 * It is a MEAN because the score is a subjective 1-5 from a model at temperature 1: the
 * same sentence has scored 2 and 4 across runs, so a per-fixture floor would make this
 * suite flip on noise rather than on quality. A mean over the corpus moves only when the
 * skill actually gets better or worse — it climbed 3.63 -> 4.13 when the skill stopped
 * pasting the deterministic summary and stopped calling a 1-year-old "your baby".
 *
 * 3 still has teeth: a 2 is what the judge gives real defects, including the Sonnet
 * composer silently de-accenting a child's name (Andre for Andre-with-an-accent) — which
 * the fabrication gate caught independently on the same run.
 *
 * The zero-tolerance gates are the objective ones below (fabrication, self-asked
 * question, length, GSM-7, recall, forbidden tokens). Those are what protect a parent;
 * this score is what tells a human whether the turn is worth paying a model for.
 */
const VOICE_MIN = 3;

/**
 * How often the model's own words must survive the shell's guards and actually ship.
 *
 * This is the gate that answers "is calling a model here worth it at all", and it is the
 * honest shape for a temperature-1 cheap tier: the composer is NOT deterministic, and
 * across live runs it occasionally asks a question of its own or writes a flat line.
 * Production is safe when that happens — usableAck rejects it, the fallback is logged and
 * NAMED, and the parent gets the deterministic follow-up — so the failure mode is a
 * colder message, never a wrong one. Demanding 8/8 perfection per run would make this
 * suite flaky without making a parent any safer.
 *
 * What is NOT relaxed is fabrication: that stays at zero, because it is the only failure
 * here that could mislead a family rather than merely underwhelm them.
 */
const MIN_USABLE_RATE = 0.75;

// Mirrors apps/web/lib/channel/intake/intake-voice.ts exactly.
const ACK_TOOL_SCHEMA = {
  type: 'object',
  properties: { ack: { type: 'string' } },
  required: ['ack'],
};

// ── replicated: sms-segments.ts encoding check ──────────────────────────────
// One character outside GSM-7 flips the whole body to UCS-2 and halves the budget. The
// ack must stay in the alphabet, so the gate counts the same way the sender will.

const GSM7_BASIC = new Set(
  [
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ]
    .join('')
    .split(''),
);
const GSM7_EXTENDED = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

function nonGsm7Chars(text) {
  const bad = [];
  for (const char of text) {
    if (!GSM7_BASIC.has(char) && !GSM7_EXTENDED.has(char)) bad.push(char);
  }
  return [...new Set(bad)];
}

// ── the hard fabrication gate ───────────────────────────────────────────────
// Every proper noun and every number in the ack must trace back to the context. This is
// the whole point of letting a model near this turn at all: it may choose the words,
// never the facts. A name, an age, or a place that appears nowhere in the context is a
// fabrication — and in an acknowledgment it is uniquely damaging, because the entire
// message is a claim about having listened correctly.

/** Capitalised words that are not proper nouns about this family. */
const ALLOWED_CAPS = new Set([
  'Hale',
  'I',
  'A',
  'An',
  'The',
  'And',
  'But',
  'So',
  'If',
  'It',
  'Got',
  'Thanks',
  'Perfect',
  'Congrats',
  'You',
  'Your',
]);

function fabrications(ack, context) {
  const hay = JSON.stringify(context).toLowerCase();
  const offenders = [];

  for (const number of ack.match(/\d+/g) ?? []) {
    if (!hay.includes(number)) offenders.push(`number "${number}" is in no fact`);
  }
  for (const url of ack.match(/https?:\/\/\S+/g) ?? []) {
    offenders.push(`link "${url}" — this skill is never given one`);
  }
  for (const sentence of ack.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/);
    for (const [index, word] of words.entries()) {
      if (index === 0) continue;
      const bare = word
        .replace(/^[^A-Za-z]+/, '')
        .replace(/['’]s$/i, '')
        .replace(/[^A-Za-z]+$/, '');
      if (!/^[A-Z][a-z]/.test(bare)) continue;
      if (ALLOWED_CAPS.has(bare)) continue;
      if (!hay.includes(bare.toLowerCase())) offenders.push(`name "${bare}" is in no fact`);
    }
  }
  return [...new Set(offenders)];
}

/**
 * The PRODUCTION predicate — usableAck in apps/web/lib/channel/intake/intake-voice.ts.
 * A composed ack failing any of these never reaches a parent: the shell logs a named
 * fallback and sends the deterministic template instead.
 */
function unusableReasons(fixture, ack) {
  const reasons = [];
  if (!ack) return ['answer failed to parse into a strict { ack } object'];
  reasons.push(...fabrications(ack, fixture.context));
  if (ack.includes('?')) {
    reasons.push('asks a question of its own (the shell appends the only question)');
  }
  if (ack.length > MAX_ACK_CHARS) reasons.push(`${ack.length} chars > ${MAX_ACK_CHARS}`);
  const bad = nonGsm7Chars(ack);
  if (bad.length > 0) {
    reasons.push(`leaves the GSM-7 alphabet: ${bad.map((c) => JSON.stringify(c)).join(', ')}`);
  }
  return reasons;
}

/**
 * The OBJECTIVE quality checks, applied only to acks that would actually ship. An ack
 * the shell already rejected cannot also fail for being cold — it was never said.
 *
 * Deliberately excludes the judge score. Recall and the forbidden tokens are
 * deterministic string facts, so they are gated per fixture at zero tolerance; the voice
 * score is a subjective 1-5 from a model and is gated on the corpus MEAN instead (see
 * VOICE_MIN), which is the resolution it is actually valid at.
 */
function qualityFailures(fixture, ack) {
  const failures = [];
  const lower = ack.toLowerCase();
  for (const token of fixture.expect.mustRecall ?? []) {
    if (!lower.includes(token.toLowerCase())) {
      failures.push(`never echoes the fact it exists for: ${JSON.stringify(token)}`);
    }
  }
  for (const token of fixture.expect.forbidden ?? []) {
    if (lower.includes(token.toLowerCase())) {
      failures.push(`says ${JSON.stringify(token)}, which no fact supports`);
    }
  }
  return failures;
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring the acknowledgment half of a text message Hale sends',
  'a parent who has just texted their kids\' names to a number they found on a poster.',
  'You are given the FACTS Hale extracted and the acknowledgment written from them. A',
  'separate question is appended after it by the system; the acknowledgment itself must',
  'not ask anything.',
  'Score VOICE & FAITHFULNESS on a 1-5 integer scale. A 5 sounds like a competent person',
  'writing back: quiet, warm, plain-spoken, SHORT, and it proves it read what the parent',
  'actually wrote. It states only the given facts, and where a fact is absent (a child',
  'with no name, a child with no age) it works around the gap naturally instead of',
  'filling it.',
  'JUDGE IT AGAINST WHAT THE PARENT ACTUALLY GAVE, not against an ideal message. This',
  'turn is capped at 160 characters, may add NO fact that is not in the context, and is',
  'followed immediately by a question. So when the parent wrote very little ("ben 2"),',
  'a short plain acknowledgment that simply gets the child right IS a 5 — there is',
  'nothing further it could honestly say, and reaching for warmth would mean inventing',
  'something or padding. Do NOT mark a message down for being brief, for lacking',
  'enthusiasm, or for not offering help. Length should track what the parent supplied.',
  'A LOW score is hype or exclamation marks, brand/corporate voice ("We are excited to"),',
  'reciting the facts back like a database row, padding to sound friendly, promising',
  'anything Hale has not done, commenting on a child\'s development or health, or any',
  'detail not present in the facts. Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: invents a venue and an age, asks its own question, and
// rambles past the ceiling. Every gate must reject it — no API call, no cache read.
const BROKEN_ACK =
  "Wonderful news, Priya! I have already found three swimming programs at the Sunnyside Community Centre for your 18 month old, and honestly there is so much more going on around you this season that I could barely fit it into one message. Shall I tell you about them?";

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  // The Sonnet tier, NOT the shared Haiku judge the other suites use. This corpus is
  // eight one-line sentences whose differences are stylistic, and the Haiku judge scored
  // semantically identical constructions 2 and 5 across runs ("Zoe is 5 and Andre is 7"
  // vs "Ben is 2") — noise at the exact resolution this gate has to discriminate at. A
  // judge that disagrees with itself gates nothing, and eight judge calls is not where
  // this eval's cost lives.
  const judgeModel = (await readModelIds()).sonnet;
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'intake-voice', cachedOnly, getClient, cost);

  console.log(
    `intake-voice-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${INTAKE_VOICE_FIXTURES.length} ack fixtures\n`);

  const results = [];
  for (const fixture of INTAKE_VOICE_FIXTURES) {
    let ack;
    if (broken) {
      ack = BROKEN_ACK;
    } else {
      // Replicates forceToolJson's request EXACTLY: the skill body as the system prompt,
      // the serialized context as the one user turn, one forced output tool
      // (apps/web/lib/channel/intake/intake-voice.ts + lib/pipeline/structured.ts).
      const { value } = await cachedToolCall({
        tag: `intake-voice:ack:${fixture.id}`,
        model,
        system: skill.instructions,
        userMessage: JSON.stringify(fixture.context),
        toolName: 'ack',
        toolDescription: 'Return the acknowledgment sentence.',
        toolSchema: ACK_TOOL_SCHEMA,
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      ack = typeof value?.ack === 'string' && value.ack.trim() !== '' ? value.ack.trim() : null;
    }

    const unusable = unusableReasons(fixture, ack);
    // An ack the shell would reject is never judged: it is not what a parent reads, and
    // paying a judge to score a discarded sentence measures nothing.
    const score =
      broken || !ack || unusable.length > 0
        ? null
        : (await judge(fixture.id, { facts: fixture.context, ack })).score;
    const quality = ack && unusable.length === 0 ? qualityFailures(fixture, ack) : [];
    results.push({ fixture, ack, score, unusable, quality });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- compose ---');
  for (const result of results) {
    const shipped = result.unusable.length === 0;
    const ok = shipped && result.quality.length === 0;
    const label = ok ? 'PASS' : shipped ? 'FAIL' : 'FELL BACK';
    console.log(
      `${label}  ${result.fixture.id}${result.score === null ? '' : `  voice=${result.score}`}`,
    );
    if (result.ack && !broken) console.log(`        "${result.ack}"`);
    for (const reason of result.unusable) console.log(`        - ${reason}`);
    for (const failure of result.quality) console.log(`        - ${failure}`);
  }

  const usable = results.filter((r) => r.unusable.length === 0);
  const fabricating = results.filter(
    (r) => r.ack && fabrications(r.ack, r.fixture.context).length > 0,
  );
  const asking = results.filter((r) => r.ack?.includes('?'));
  const tooLong = results.filter((r) => r.ack && r.ack.length > MAX_ACK_CHARS);
  const nonGsm7 = results.filter((r) => r.ack && nonGsm7Chars(r.ack).length > 0);
  const qualityFails = usable.filter((r) => r.quality.length > 0);
  const scores = results.map((r) => r.score).filter((s) => typeof s === 'number');
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const usableRate = usable.length / results.length;
  const lengths = usable.map((r) => `${r.ack}`.length);

  console.log('\n--- corpus metrics ---');
  console.log(
    `USABLE (would actually ship):  ${usable.length}/${results.length} = ${(usableRate * 100).toFixed(1)}%  (>= ${(MIN_USABLE_RATE * 100).toFixed(0)}% required)`,
  );
  console.log(`FABRICATIONS:                  ${fabricating.length}  (0 required — the hard gate)`);
  console.log(`  of which: asked a question   ${asking.length}`);
  console.log(`  of which: over ${MAX_ACK_CHARS} chars      ${tooLong.length}`);
  console.log(`  of which: outside GSM-7      ${nonGsm7.length}`);
  console.log(`shipped acks failing recall:   ${qualityFails.length}  (0 required)`);
  console.log(`mean voice score (shipped):    ${meanScore.toFixed(2)}  (mean >= ${VOICE_MIN} required)`);
  if (lengths.length) {
    console.log(
      `ack length:                    min ${Math.min(...lengths)} / max ${Math.max(...lengths)} chars`,
    );
  }

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    fabricating.length === 0 &&
    usableRate >= MIN_USABLE_RATE &&
    qualityFails.length === 0 &&
    meanScore >= VOICE_MIN;

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
  console.error('intake-voice eval harness error:', err);
  process.exit(2);
});
