// E2 sentinel triage/extraction eval (VIL-225, hard rule #8: no LLM mocking).
//
// The subject is the two REAL skills (packages/agent/skills/triage-child-event.md,
// extract-child-event.md) run through the REAL forced-tool-JSON request shape
// apps/web/lib/sentinel/{triage,extract}.ts build — REPLICATED here rather than
// imported, the same reasoning the drafter/discovery evals use: those modules sit
// behind the web app's `~/` alias, which the tsx loader here can't resolve. The
// SKILL bodies and model routing ARE imported live (packages/agent has no `~`
// aliases), so a skill edit or a model.ts re-tiering re-keys the cache and is
// caught here, same as every other eval in this directory.
//
// The pipeline's DETERMINISTIC pieces — correlateExtraction (apps/web/lib/
// sentinel/correlate.ts) and the teen-content backstop (pipeline.ts) — are NOT
// re-tested here; they're pure functions with their own vitest unit tests
// (apps/web/lib/sentinel/correlate.test.ts, pipeline.test.ts) that need no model.
// This eval is purely about the two LLM stages' judgment quality.
//
// Extraction runs ONLY when the fixture's ACTUAL (not expected) triage call said
// child_related — mirroring the real pipeline's cost-shaped short-circuit, so a
// triage miss/false-positive shows up in the end-to-end false-alarm metric
// exactly as it would in production.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-sentinel-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-sentinel-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-sentinel-eval.mjs --cached-only                    # CI: replay only, never calls the API
//
// Calibrated BOTH directions: the real cached model clears every gate; the
// --broken stand-in (triage says everything is child-related; extraction always
// answers the same kind/false teen_content) fails the false-alarm-rate gate AND
// the kind-accuracy gate AND the teen-content gate — proving the gates have teeth.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { cachedToolCall, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';
import { CHILDREN, FAMILY_TIMEZONE, FIXTURES, RECEIVED_AT } from './sentinel-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const TRIAGE_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'triage-child-event.md');
const EXTRACT_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'extract-child-event.md');

// Mirrors apps/web/lib/sentinel/triage.ts's schema exactly.
const TRIAGE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    child_related: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
  },
  required: ['child_related', 'confidence', 'rationale'],
};

// Mirrors apps/web/lib/sentinel/extract.ts's schema exactly.
const EXTRACT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['cancellation', 'reschedule', 'new_event', 'reminder_only', 'unclear'] },
    event: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        child_ref: { type: ['string', 'null'] },
        original_time: { type: ['string', 'null'] },
        new_time: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
      },
      required: ['title'],
    },
    source_confidence: { type: 'number', minimum: 0, maximum: 1 },
    quote_evidence: { type: 'string' },
    teen_content: { type: 'boolean' },
  },
  required: ['kind', 'event', 'source_confidence', 'quote_evidence'],
};

const CHILD_ID_TO_KEY = { 'child-leo': 'leo', 'child-maya': 'maya' };

const BROKEN_TRIAGE = { child_related: true, confidence: 0.99, rationale: 'stand-in: always positive' };
const BROKEN_EXTRACTION = {
  kind: 'new_event',
  event: { title: 'Generic event', child_ref: null, original_time: null, new_time: '2026-01-01T09:00:00-05:00', location: null },
  source_confidence: 0.9,
  quote_evidence: 'stand-in quote',
  teen_content: false,
};

function triageUserMessage(fixture) {
  return JSON.stringify({
    envelope: fixture.envelope,
    children: CHILDREN.map((c) => c.name),
  });
}

function extractUserMessage(fixture) {
  return JSON.stringify({
    email: { subject: fixture.envelope.subject, from: fixture.envelope.from, body: fixture.body },
    received_at: RECEIVED_AT,
    family_timezone: FAMILY_TIMEZONE,
    children: CHILDREN.map((c) => ({ id: c.id, name: c.name, ageInMonths: c.ageInMonths })),
  });
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const triageSkill = await agent.loadSkill(TRIAGE_SKILL_PATH);
  const extractSkill = await agent.loadSkill(EXTRACT_SKILL_PATH);
  const triageModel = agent.pickModel(triageSkill.meta.task);
  const extractModel = agent.pickModel(extractSkill.meta.task);

  console.log(
    `sentinel-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | triage=${triageModel} extract=${extractModel}`,
  );
  console.log(`corpus: ${FIXTURES.length} fixtures\n`);

  const results = [];
  for (const fixture of FIXTURES) {
    const triageValue = broken
      ? BROKEN_TRIAGE
      : (
          await cachedToolCall({
            tag: `sentinel:triage:${fixture.id}`,
            model: triageModel,
            system: triageSkill.instructions,
            userMessage: triageUserMessage(fixture),
            toolName: 'triage',
            toolSchema: TRIAGE_TOOL_SCHEMA,
            toolDescription: 'Return whether this envelope is worth a full-body fetch.',
            maxTokens: 256,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;

    let extractValue = null;
    if (triageValue.child_related) {
      extractValue = broken
        ? BROKEN_EXTRACTION
        : (
            await cachedToolCall({
              tag: `sentinel:extract:${fixture.id}`,
              model: extractModel,
              system: extractSkill.instructions,
              userMessage: extractUserMessage(fixture),
              toolName: 'extraction',
              toolSchema: EXTRACT_TOOL_SCHEMA,
              toolDescription: 'Return the structured child-event extraction.',
              maxTokens: 1024,
              cachedOnly,
              getClient,
              cost,
            })
          ).value;
    }

    results.push({ fixture, triageValue, extractValue });
  }

  // ── metrics (all spec-derived from FIXTURES.expected — see module header) ──
  const truePositives = results.filter((r) => r.fixture.expected.triagePositive);
  const trueNegatives = results.filter((r) => !r.fixture.expected.triagePositive);
  const actualPositives = results.filter((r) => r.triageValue.child_related);

  const triageRecallHits = truePositives.filter((r) => r.triageValue.child_related).length;
  const triageRecall = truePositives.length ? triageRecallHits / truePositives.length : 1;

  const triagePrecisionHits = actualPositives.filter((r) => r.fixture.expected.triagePositive).length;
  const triagePrecision = actualPositives.length ? triagePrecisionHits / actualPositives.length : 1;

  const falseAlarms = trueNegatives.filter((r) => r.triageValue.child_related);
  const falseAlarmRate = trueNegatives.length ? falseAlarms.length / trueNegatives.length : 0;

  const kindCheckable = results.filter(
    (r) => r.extractValue && r.fixture.expected.kind && !r.fixture.expected.skipKindCheck,
  );
  const kindHits = kindCheckable.filter((r) => r.extractValue.kind === r.fixture.expected.kind);
  const kindAccuracy = kindCheckable.length ? kindHits.length / kindCheckable.length : 1;

  const teenCheckable = results.filter((r) => r.extractValue && r.fixture.expected.teenContent !== undefined);
  const teenHits = teenCheckable.filter((r) => r.extractValue.teen_content === r.fixture.expected.teenContent);
  const teenAccuracy = teenCheckable.length ? teenHits.length / teenCheckable.length : 1;

  const childRefCheckable = results.filter(
    (r) => r.extractValue && r.fixture.expected.expectedChildRef !== undefined,
  );
  const childRefMismatches = childRefCheckable.filter((r) => {
    const expected = r.fixture.expected.expectedChildRef;
    const actualKey = r.extractValue.event.child_ref ? CHILD_ID_TO_KEY[r.extractValue.event.child_ref] ?? null : null;
    return actualKey !== expected;
  });

  const timeCheckable = results.filter(
    (r) => r.extractValue && (r.fixture.expected.requiresOriginalTime || r.fixture.expected.requiresNewTime),
  );
  const timeMismatches = timeCheckable.filter((r) => {
    const missingOriginal = r.fixture.expected.requiresOriginalTime && !r.extractValue.event.original_time;
    const missingNew = r.fixture.expected.requiresNewTime && !r.extractValue.event.new_time;
    return missingOriginal || missingNew;
  });

  // ── report ───────────────────────────────────────────────────────────────
  console.log('--- per-fixture ---');
  for (const r of results) {
    const triageOk = r.triageValue.child_related === r.fixture.expected.triagePositive;
    const kindOk =
      !r.fixture.expected.kind || r.fixture.expected.skipKindCheck || !r.extractValue
        ? true
        : r.extractValue.kind === r.fixture.expected.kind;
    const ok = triageOk && kindOk;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${r.fixture.id}  triage=${r.triageValue.child_related}${
        r.extractValue ? ` kind=${r.extractValue.kind} teen=${r.extractValue.teen_content}` : ''
      }`,
    );
  }

  console.log('\n--- corpus metrics ---');
  console.log(`triage recall:          ${(triageRecall * 100).toFixed(1)}%  (>= 95% required)`);
  console.log(`triage precision:       ${(triagePrecision * 100).toFixed(1)}%  (>= 60% required)`);
  console.log(`extraction kind accuracy: ${(kindAccuracy * 100).toFixed(1)}%  (>= 90% required)`);
  console.log(
    `end-to-end false-alarm rate: ${(falseAlarmRate * 100).toFixed(1)}%  (<= 2% required — on this ${trueNegatives.length}-negative corpus that collapses to 0 tolerated false positives)`,
  );
  console.log(`teen-content line accuracy: ${(teenAccuracy * 100).toFixed(1)}%  (100% required — rule #1)`);
  console.log(`child_ref hallucination checks: ${childRefCheckable.length - childRefMismatches.length}/${childRefCheckable.length} correct`);
  console.log(`required-time-field presence: ${timeCheckable.length - timeMismatches.length}/${timeCheckable.length} correct`);

  const extractionCount = results.filter((r) => r.extractValue !== null).length;
  const discardRate = 1 - extractionCount / FIXTURES.length;
  console.log('\n--- cost telemetry ---');
  console.log(`triage discard rate this corpus: ${(discardRate * 100).toFixed(1)}% (${FIXTURES.length - extractionCount}/${FIXTURES.length} never reached extraction)`);
  console.log(`extraction rate: ${((extractionCount / FIXTURES.length) * 100).toFixed(1)}%`);
  console.log(`live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`);
  if (cost.liveCalls > 0) {
    const perEnvelopeUsd = totalUsd(cost) / FIXTURES.length;
    console.log(`~ $${(perEnvelopeUsd * 1000).toFixed(4)} USD per 1k envelopes at this corpus's triage-positive rate`);
  }

  const allPass =
    triageRecall >= 0.95 &&
    triagePrecision >= 0.6 &&
    kindAccuracy >= 0.9 &&
    falseAlarmRate === 0 &&
    teenAccuracy === 1 &&
    childRefMismatches.length === 0 &&
    timeMismatches.length === 0;

  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(`broken-mode calibration (must fail at least one gate): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('sentinel eval harness error:', err);
  process.exit(2);
});
