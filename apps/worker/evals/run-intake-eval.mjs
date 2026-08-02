// VIL-237 · M2 conversational SMS intake eval (hard rule #8: no LLM mocking).
//
// The subject is the two REAL skills (packages/agent/skills/intake-extraction.md,
// reply-intent.md) run through the REAL forced-tool-JSON request shape
// apps/web/lib/channel/intake/{extract,intent}.ts build — REPLICATED here rather than
// imported, for the same reason the sentinel/drafter evals replicate: those modules sit
// behind the web app's `~/` alias, which the tsx loader here cannot resolve. The SKILL
// bodies and the model routing ARE imported live from packages/agent (no `~` aliases),
// so a skill edit or a model.ts re-tiering re-keys the cache and shows up here.
//
// The state machine's DETERMINISTIC pieces — the CASL keyword guards, the region gate,
// the one-follow-up cap, provisioning, and the consent-before-flag ordering — are NOT
// re-tested here; they are pure/DB code with their own vitest suites
// (apps/web/lib/channel/intake/*.test.ts) that need no model. This eval is only about
// the two LLM stages' judgment.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-intake-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-intake-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-intake-eval.mjs --cached-only                    # CI: replay only
//
// Calibrated BOTH directions: the real cached model clears every gate; the --broken
// stand-in (an extractor that invents a child and a postal code, and an intent reader
// that calls everything assent) fails the fabrication gate, the accuracy gates AND the
// consent false-positive gate — proving the gates have teeth.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { cachedToolCall, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';
import { EXTRACTION_FIXTURES, INTENT_FIXTURES, INTENT_QUESTION } from './intake-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const EXTRACT_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'intake-extraction.md');
const INTENT_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'reply-intent.md');

/** A child at the top of Hale's range (18) is 216 months — mirrors extract.ts. */
const MAX_AGE_MONTHS = 216;

// Mirrors apps/web/lib/channel/intake/extract.ts exactly.
const EXTRACT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    children: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          age_months: { type: ['number', 'null'], minimum: 0, maximum: MAX_AGE_MONTHS },
          age_precision: { type: ['string', 'null'], enum: ['years', 'months', null] },
        },
      },
    },
    postal_code: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['children', 'confidence'],
};

// Mirrors apps/web/lib/channel/intake/intent.ts exactly.
const INTENT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['assent', 'decline', 'ambiguous'] },
    verbatim: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['intent', 'verbatim', 'rationale', 'confidence'],
};

const BROKEN_EXTRACTION = {
  children: [{ name: 'Charlie', age_months: 60, age_precision: 'years' }],
  postal_code: 'M5V 2T6',
  confidence: 0.99,
};
const BROKEN_INTENT = {
  intent: 'assent',
  verbatim: 'stand-in',
  rationale: 'stand-in: everything is a yes',
  confidence: 0.99,
};

const DEFAULT_AGE_TOLERANCE_MONTHS = 1;

function extractionUserMessage(fixture) {
  return JSON.stringify({ message: fixture.message, already_known: fixture.alreadyKnown });
}

function intentUserMessage(fixture) {
  return JSON.stringify({ question: INTENT_QUESTION, reply: fixture.reply });
}

function normalizePostal(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  return compact.length === 6 ? `${compact.slice(0, 3)} ${compact.slice(3)}` : compact;
}

/** Every name/postal token the model returned must be TRACEABLE to the input it was
 * given (the message plus what was already known). This is the hallucination check:
 * a fabricated child or a completed postal code fails here, deterministically. */
function fabrications(fixture, value) {
  const haystack = `${fixture.message} ${JSON.stringify(fixture.alreadyKnown)}`.toLowerCase();
  const offenders = [];
  for (const child of value.children ?? []) {
    if (typeof child.name === 'string' && !haystack.includes(child.name.toLowerCase())) {
      offenders.push(`name "${child.name}" appears nowhere in the input`);
    }
  }
  if (typeof value.postal_code === 'string') {
    const compact = value.postal_code.replace(/[\s-]/g, '').toLowerCase();
    if (!haystack.replace(/[\s-]/g, '').includes(compact)) {
      offenders.push(`postal code "${value.postal_code}" appears nowhere in the input`);
    }
  }
  return offenders;
}

/** Field-by-field comparison against the SPEC-derived expectation. Children are matched
 * positionally — the skill is told to return them in the order the parent said them. */
function scoreExtraction(fixture, value) {
  const tolerance = fixture.expect.ageToleranceMonths ?? DEFAULT_AGE_TOLERANCE_MONTHS;
  const actual = value.children ?? [];
  const expected = fixture.expect.children;
  const failures = [];

  if (actual.length !== expected.length) {
    failures.push(`child count ${actual.length} != ${expected.length}`);
  }
  for (const [i, want] of expected.entries()) {
    const got = actual[i];
    if (!got) continue;
    const gotName = typeof got.name === 'string' ? got.name.trim() : null;
    if ((want.name ?? null) !== (gotName ?? null)) {
      failures.push(`child ${i} name ${JSON.stringify(gotName)} != ${JSON.stringify(want.name)}`);
    }
    if (want.ageMonths === null) {
      if (got.age_months !== null && got.age_months !== undefined) {
        failures.push(`child ${i} age ${got.age_months} should have been null`);
      }
    } else if (
      typeof got.age_months !== 'number' ||
      Math.abs(got.age_months - want.ageMonths) > tolerance
    ) {
      failures.push(`child ${i} age ${got.age_months} != ${want.ageMonths} (±${tolerance})`);
    }

    // EXACT, never tolerant: `age_precision` is what decides whether the stored date of
    // birth gets a six-month midpoint correction (VIL-260). There is no "close" — a
    // 'years' read of "18 months" ships a two-year-old the parent never described.
    const gotPrecision = got.age_precision ?? null;
    if (gotPrecision !== (want.agePrecision ?? null)) {
      failures.push(
        `child ${i} age_precision ${JSON.stringify(gotPrecision)} != ${JSON.stringify(want.agePrecision ?? null)}`,
      );
    }
  }

  const gotPostal = normalizePostal(value.postal_code);
  if (gotPostal !== fixture.expect.postalCode) {
    failures.push(`postal ${JSON.stringify(gotPostal)} != ${JSON.stringify(fixture.expect.postalCode)}`);
  }

  return failures;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const extractSkill = await agent.loadSkill(EXTRACT_SKILL_PATH);
  const intentSkill = await agent.loadSkill(INTENT_SKILL_PATH);
  const extractModel = agent.pickModel(extractSkill.meta.task);
  const intentModel = agent.pickModel(intentSkill.meta.task);

  console.log(
    `intake-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | extract=${extractModel} intent=${intentModel}`,
  );
  console.log(
    `corpus: ${EXTRACTION_FIXTURES.length} extraction + ${INTENT_FIXTURES.length} intent fixtures\n`,
  );

  // ── extraction suite ───────────────────────────────────────────────────────
  const extractionResults = [];
  for (const fixture of EXTRACTION_FIXTURES) {
    const value = broken
      ? BROKEN_EXTRACTION
      : (
          await cachedToolCall({
            tag: `intake:extract:${fixture.id}`,
            model: extractModel,
            system: extractSkill.instructions,
            userMessage: extractionUserMessage(fixture),
            toolName: 'intake',
            toolSchema: EXTRACT_TOOL_SCHEMA,
            toolDescription: "Return the merged picture of the family's kids and postal code.",
            maxTokens: 512,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    extractionResults.push({
      fixture,
      value,
      failures: scoreExtraction(fixture, value),
      fabrications: fabrications(fixture, value),
    });
  }

  // ── intent suite ───────────────────────────────────────────────────────────
  const intentResults = [];
  for (const fixture of INTENT_FIXTURES) {
    const value = broken
      ? BROKEN_INTENT
      : (
          await cachedToolCall({
            tag: `intake:intent:${fixture.id}`,
            model: intentModel,
            system: intentSkill.instructions,
            userMessage: intentUserMessage(fixture),
            toolName: 'intent',
            toolSchema: INTENT_TOOL_SCHEMA,
            toolDescription: "Return how the parent's reply reads.",
            maxTokens: 256,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    intentResults.push({ fixture, value });
  }

  // ── metrics ────────────────────────────────────────────────────────────────
  const extractionPasses = extractionResults.filter(
    (r) => r.failures.length === 0 && r.fabrications.length === 0,
  );
  const extractionAccuracy = extractionPasses.length / extractionResults.length;
  const fabricationCount = extractionResults.filter((r) => r.fabrications.length > 0).length;

  const intentHits = intentResults.filter((r) => r.value.intent === r.fixture.expect);
  const intentAccuracy = intentHits.length / intentResults.length;

  // The gate that matters most: nothing in the false-positive battery may read as
  // assent. One is a consent record for a family who never agreed.
  const consentFalsePositives = intentResults.filter(
    (r) => r.fixture.falsePositive && r.value.intent === 'assent',
  );
  // The other direction: a plain yes read as anything else costs a clarifying question.
  const assentFixtures = intentResults.filter((r) => r.fixture.expect === 'assent');
  const assentRecall = assentFixtures.filter((r) => r.value.intent === 'assent').length /
    (assentFixtures.length || 1);
  // A decline must never read as assent either — that is the same manufactured consent.
  const declineFixtures = intentResults.filter((r) => r.fixture.expect === 'decline');
  const declineAsAssent = declineFixtures.filter((r) => r.value.intent === 'assent');

  const verbatimMismatches = broken
    ? []
    : intentResults.filter((r) => r.value.verbatim !== r.fixture.reply);

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- extraction ---');
  for (const r of extractionResults) {
    const ok = r.failures.length === 0 && r.fabrications.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.fixture.id}${ok ? '' : `  ${[...r.failures, ...r.fabrications].join('; ')}`}`);
  }

  console.log('\n--- intent ---');
  for (const r of intentResults) {
    const ok = r.value.intent === r.fixture.expect;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${r.fixture.id}  got=${r.value.intent} want=${r.fixture.expect}`,
    );
  }

  console.log('\n--- corpus metrics ---');
  console.log(`extraction field accuracy:   ${(extractionAccuracy * 100).toFixed(1)}%  (>= 85% required)`);
  console.log(`extraction fabrications:     ${fabricationCount}  (0 required)`);
  console.log(`intent accuracy:             ${(intentAccuracy * 100).toFixed(1)}%  (>= 85% required)`);
  console.log(`assent recall:               ${(assentRecall * 100).toFixed(1)}%  (>= 80% required)`);
  console.log(`consent FALSE POSITIVES:     ${consentFalsePositives.length}  (0 required — a manufactured consent)`);
  console.log(`declines read as assent:     ${declineAsAssent.length}  (0 required)`);
  console.log(`verbatim echo mismatches:    ${verbatimMismatches.length}  (0 required)`);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    extractionAccuracy >= 0.85 &&
    fabricationCount === 0 &&
    intentAccuracy >= 0.85 &&
    assentRecall >= 0.8 &&
    consentFalsePositives.length === 0 &&
    declineAsAssent.length === 0 &&
    verbatimMismatches.length === 0;

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
  console.error('intake eval harness error:', err);
  process.exit(2);
});
