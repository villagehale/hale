// Reading a parent's message for an actionable request · classifier eval (hard rule #8:
// no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/request-intent.md) run through the
// REAL user turn the handler builds and settled through the REAL guards:
// `requestIntentUserMessage` and `settleRequestIntent`
// (apps/web/lib/channel/connect/request-intent-reading.ts) are pure, relative-import
// modules, so tsx loads them live. A change to the skill or to what the model is told
// re-keys the cache and shows up here as a miss rather than as silence.
//
// WHY THIS EXISTS. Founder rule 2026-10-04: intent is inferred by the model, never by a
// keyword branch. Until VIL-413 / VIL-417 two regexes decided this - `matchConnectorRequest`
// (a connect verb class, a provider noun class, a negation class, a status-auxiliary
// class) and `matchBothFreeAsk` (five fixed phrasings). They are gone. The model says
// whether a message asks to connect an account or for a shared-free window; code acts on
// the label through the guards and never on a word. A false connect reading mints a
// credential link nobody asked for, so the floor is 0.7 and every override lands on
// `other`, which hands the turn to the coach.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-request-intent-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-request-intent-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-request-intent-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS, each named for the harm it stands in for:
//   · a FALSE REQUEST - a non-request settled as connect_* or both_free: a link minted or
//     a window planned for a parent who asked a question, said no, or made conversation.
//   · a MISSED REQUEST - a connect or both-free ask settled as other: a parent asking in
//     plain words and getting a coach answer instead. The keyword table with extra steps.
//   · a WRONG ACCOUNT - a connect ask settled as a different connect_*: a Gmail link for a
//     calendar ask.
//   · a DISCARDED ECHO - a verbatim the guard rejects. The model answered and the answer
//     never survived the wire; counted separately because it is not a reading failure.
//   · a RESPONSE PROD CANNOT PARSE - a field missing or out of range.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { cachedToolCall, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';
import { REQUEST_INTENT_FIXTURES } from './request-intent-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'request-intent.md');
const READING_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'connect',
  'request-intent-reading.ts',
);

/**
 * Mirrors MAX_TOKENS in apps/web/lib/channel/connect/request-intent.ts. It is in the
 * cache tag because `cachedToolCall`'s key does not cover it, and the budget decides
 * whether the trailing `rationale` completes.
 */
const MAX_TOKENS = 256;

const LABELS = ['connect_gcal', 'connect_gmail', 'connect_gdrive', 'both_free', 'other'];

/** Mirrors `answerJsonSchema` in request-intent.ts exactly. */
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

/** Mirrors `answerSchema` (zod) in request-intent.ts: returns null where prod would throw
 * and retry, then fail the read as `model_failed`. */
function parseAnswer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!LABELS.includes(raw.intent)) return null;
  if (typeof raw.verbatim !== 'string' || typeof raw.rationale !== 'string') return null;
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) return null;
  return raw;
}

const CONNECT = new Set(['connect_gcal', 'connect_gmail', 'connect_gdrive']);
const REQUEST = new Set([...CONNECT, 'both_free']);

// The broken stand-in: an eager reader that hears "connect my calendar" in everything. It
// trips the false-request zero on every non-request fixture and the wrong-account zero on
// the Gmail and Drive ones. It does NOT trip the plain calendar fixtures - a corpus where
// one confident guess passes everything would not be a corpus.
function brokenAnswer(input) {
  return {
    intent: 'connect_gcal',
    verbatim: input.message,
    rationale: 'stand-in: everything is a calendar connect',
    confidence: 0.99,
  };
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { requestIntentUserMessage, settleRequestIntent } = await tsImport(
    READING_SRC,
    import.meta.url,
  );
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);

  console.log(
    `request-intent eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | reader=${model}`,
  );
  console.log(`corpus: ${REQUEST_INTENT_FIXTURES.length} messages\n`);

  const results = [];
  for (const fixture of REQUEST_INTENT_FIXTURES) {
    const raw = broken
      ? brokenAnswer(fixture.input)
      : (
          await cachedToolCall({
            tag: `request-intent:${MAX_TOKENS}:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: requestIntentUserMessage(fixture.input),
            toolName: 'intent',
            toolSchema: INTENT_TOOL_SCHEMA,
            toolDescription: "Return what the parent's message asks for.",
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;

    // Exactly prod's order: parse, then settle. A parse failure is retried in prod and
    // then becomes `model_failed`, which the handler treats as `other` and hands on.
    const parsed = parseAnswer(raw);
    const settled = parsed
      ? settleRequestIntent(parsed, fixture.input)
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
  const falseRequest = results.filter(
    (r) => REQUEST.has(r.settled.intent) && !REQUEST.has(r.fixture.expect),
  );
  const missedRequest = results.filter(
    (r) => REQUEST.has(r.fixture.expect) && r.settled.intent === 'other',
  );
  const wrongAccount = results.filter(
    (r) =>
      CONNECT.has(r.fixture.expect) &&
      CONNECT.has(r.settled.intent) &&
      r.settled.intent !== r.fixture.expect,
  );
  const discardedEcho = results.filter(
    (r) => r.parsed !== null && r.parsed.verbatim !== r.fixture.input.message,
  );
  const unparseable = results.filter((r) => r.parsed === null);

  console.log('\n--- corpus metrics ---');
  console.log(
    `UNPARSEABLE in prod:      ${unparseable.length}  (0 required - a field missing or out of range; prod retries once then hands the turn on)`,
  );
  console.log(
    `DISCARDED ECHOES:         ${discardedEcho.length}  (0 required - the model did not copy the message back exactly, so its reading was thrown away)`,
  );
  console.log(
    `FALSE REQUESTS:           ${falseRequest.length}  (0 required - a credential link minted, or a window planned, for a parent who asked a question or said no)`,
  );
  console.log(
    `MISSED REQUESTS:          ${missedRequest.length}  (0 required - plain words for "connect my calendar" ignored is the keyword table with extra steps)`,
  );
  console.log(
    `WRONG ACCOUNT:            ${wrongAccount.length}  (0 required - a Gmail link for a calendar ask)`,
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
  console.error('request-intent eval harness error:', err);
  process.exit(2);
});
