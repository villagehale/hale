// Reading a parent's reply in the evening check-in lane · eval (hard rule #8: no LLM
// mocking).
//
// The subject is the REAL skill (packages/agent/skills/checkin-intent.md) run through the
// REAL request shape and the REAL guards. Nothing is replicated here:
// `checkInIntentUserMessage` and `settleCheckInIntent`
// (apps/web/lib/channel/checkin/intent-reading.ts) are a pure module with relative
// imports only, so tsx loads them live. A change to what the model is told, to a guard,
// or to the skill re-keys the cache and shows up here as a miss rather than as silence.
//
// THIS IS A READER, NOT A COMPOSER - so there is no judge and no variation gate, and
// there must not be. The whole output is one of six labels, and every fixture has an
// exactly right one. It is scored the way the reply resolver is scored: exact outcomes,
// hard zeros where a wrong read does something.
//
// WHAT IS SCORED IS THE SETTLED READING, NOT THE JSON. Every fixture asserts against the
// output of `settleCheckInIntent` - the verbatim check, the confidence floor on cadence
// intents, the already-there guard - because that is what production acts on. The raw
// `{intent, confidence}` is printed alongside so the model's actual certainty is visible.
//
// WHY THIS LANE READS AT ALL. Until VIL-413 / VIL-417 it matched LESS, NO and DAILY
// whole-string and printed those words in every ask. Founder rule 2026-10-04: Hale never
// asks a parent to reply with a keyword. So the words are gone from the asks, and the
// reply is read in the parent's own language. Code stores a cadence and enforces the
// limits; nothing the reader decides is sent to the parent.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-checkin-intent-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-checkin-intent-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-checkin-intent-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · a WRONG CADENCE CHANGE - a day note, a request or a nothing read as a wish to hear
//     from Hale less, more, or not at all. The only harm this stage can do on its own: it
//     changes how often a family hears from Hale for a month, on a guess.
//   · a MISSED CADENCE CHANGE - "less often please" read as a day note. The parent is
//     thanked for a diary line they did not write and asked again tomorrow. A reader that
//     plays safe and reads everything as other is the keyword table with extra steps.
//   · a LOST REQUEST - "can you add dentist to the calendar" read as a day note. The
//     parent asked for something and got a thank-you.
//   · a DISCARDED ECHO - a verbatim the guard rejects. The model answered and the answer
//     never survived the wire; counted separately because it is not a reading failure.
//   · a RESPONSE PROD CANNOT PARSE - a field missing or out of range.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CHECKIN_INTENT_FIXTURES } from './checkin-intent-fixtures.mjs';
import { cachedToolCall, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'checkin-intent.md');
const READING_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'checkin',
  'intent-reading.ts',
);

/**
 * Mirrors MAX_TOKENS in apps/web/lib/channel/checkin/intent.ts. It is in the cache tag
 * because `cachedToolCall`'s key does not cover it, and the budget decides whether the
 * trailing `rationale` completes (the reply-resolver eval header has the history).
 */
const MAX_TOKENS = 256;

const LABELS = ['cadence_weekly', 'cadence_off', 'cadence_daily', 'day_note', 'request', 'other'];

/** Mirrors `answerJsonSchema` in intent.ts exactly. */
const INTENT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: LABELS },
    verbatim: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['intent', 'verbatim', 'rationale', 'confidence'],
};

/** Mirrors `answerSchema` (zod) in intent.ts: returns null where prod would throw and
 * retry, then fail the read as `model_failed`. */
function parseAnswer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!LABELS.includes(raw.intent)) return null;
  if (typeof raw.verbatim !== 'string' || typeof raw.rationale !== 'string') return null;
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) return null;
  return raw;
}

const CADENCE = new Set(['cadence_weekly', 'cadence_off', 'cadence_daily']);

// The broken stand-in: an eager reader that hears "stop" in everything. It trips the
// wrong-cadence zero on every non-cadence fixture and the missed-cadence zero on the
// weekly and daily ones. It does NOT trip the cadence_off fixtures - a corpus where one
// confident guess passes everything would not be a corpus.
function brokenAnswer(input) {
  return {
    intent: 'cadence_off',
    verbatim: input.reply,
    rationale: 'stand-in: everything is a wish for these to stop',
    confidence: 0.99,
  };
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { checkInIntentUserMessage, settleCheckInIntent } = await tsImport(
    READING_SRC,
    import.meta.url,
  );
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);

  console.log(
    `checkin-intent eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | reader=${model}`,
  );
  console.log(`corpus: ${CHECKIN_INTENT_FIXTURES.length} replies\n`);

  const results = [];
  for (const fixture of CHECKIN_INTENT_FIXTURES) {
    const raw = broken
      ? brokenAnswer(fixture.input)
      : (
          await cachedToolCall({
            tag: `checkin-intent:${MAX_TOKENS}:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: checkInIntentUserMessage(fixture.input),
            toolName: 'intent',
            toolSchema: INTENT_TOOL_SCHEMA,
            toolDescription: "Return what the parent's reply is.",
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;

    // Exactly prod's order: parse, then settle. A parse failure is retried in prod and
    // then becomes `model_failed`, which the handler treats as `other` and declines.
    const parsed = parseAnswer(raw);
    const settled = parsed
      ? settleCheckInIntent(parsed, fixture.input)
      : { intent: 'other', interpretation: 'model_failed' };

    const failures = [];
    if (settled.intent !== fixture.expect) {
      failures.push(`read ${settled.intent} - wanted ${fixture.expect}`);
    }
    results.push({ fixture, raw, parsed, settled, failures });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- readings ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    const rawTag = r.parsed
      ? `${r.raw.intent}@${Number(r.raw.confidence).toFixed(2)}`
      : 'UNPARSEABLE';
    console.log(
      `${tag}  ${r.fixture.id.padEnd(30)} raw=${rawTag.padEnd(20)} ->  ${r.settled.intent} (${r.settled.interpretation})`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
    if (r.failures.length > 0) console.log(`      why this fixture: ${r.fixture.why}`);
  }

  // ── metrics ────────────────────────────────────────────────────────────────
  const wrongCadence = results.filter(
    (r) => CADENCE.has(r.settled.intent) && r.settled.intent !== r.fixture.expect,
  );
  const missedCadence = results.filter(
    (r) => CADENCE.has(r.fixture.expect) && !CADENCE.has(r.settled.intent),
  );
  const lostRequest = results.filter(
    (r) => r.fixture.expect === 'request' && r.settled.intent !== 'request',
  );
  const discardedEcho = results.filter(
    (r) => r.parsed !== null && r.parsed.verbatim !== r.fixture.input.reply,
  );
  const unparseable = results.filter((r) => r.parsed === null);

  console.log('\n--- corpus metrics ---');
  console.log(
    `UNPARSEABLE in prod:      ${unparseable.length}  (0 required - a field missing or out of range; prod retries once then declines the turn)`,
  );
  console.log(
    `DISCARDED ECHOES:         ${discardedEcho.length}  (0 required - the model did not copy the reply back exactly, so its reading was thrown away)`,
  );
  console.log(
    `WRONG CADENCE CHANGES:    ${wrongCadence.length}  (0 required - a family hears from Hale less, more or never, on a guess)`,
  );
  console.log(
    `MISSED CADENCE CHANGES:   ${missedCadence.length}  (0 required - plain English for "less" ignored is the keyword table with extra steps)`,
  );
  console.log(
    `LOST REQUESTS:            ${lostRequest.length}  (0 required - the parent asked for something and got a thank-you)`,
  );
  console.log(
    `fixtures failing:         ${results.filter((r) => r.failures.length > 0).length} / ${results.length}`,
  );

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);

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
  console.error('checkin-intent eval harness error:', err);
  process.exit(2);
});
