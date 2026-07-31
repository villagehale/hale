// VIL-245 · M10 birthday-party extraction eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/party-extraction.md) run through
// the REAL forced-tool-JSON request shape apps/web/lib/party/extract.ts builds —
// REPLICATED here rather than imported, for the same reason the intake/sentinel evals
// replicate: that module sits behind the web app's `~/` alias, which the tsx loader
// cannot resolve. The SKILL body and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows
// up here.
//
// What this stage feeds is a PUBLIC PAGE, so the gates are asymmetric and they say so:
//
//   FABRICATION is a hard zero. A location or a child name the parent did not write is
//     a wrong address in fifteen households' hands.
//   A HALLUCINATED DATETIME is a hard zero. It has two forms and both are checked: a
//     date returned where the message contains none Hale could resolve (the skill is
//     told to return null and let Hale ask ONE question), and a date outside the window
//     the runtime accepts (in the past, or more than two years out).
//   HOSTING FALSE POSITIVES are a hard zero. Reading "we're going to Leo's party" as a
//     party this family is throwing would have Hale offer to publish a page for someone
//     else's child.
//
// The deterministic pieces — the keyword matchers, the offer window, the teen
// redaction, the guest write path — are NOT re-tested here; they are pure/DB code with
// their own vitest suites (apps/web/lib/party/*.test.ts) that need no model.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-rsvp-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-rsvp-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-rsvp-eval.mjs --cached-only                    # CI: replay only
//
// Calibrated BOTH directions: the real cached model clears every gate; the --broken
// stand-in (an extractor that invents a venue, a child and a date, and calls every
// message a party it is hosting) fails the fabrication gate, the datetime gate, the
// hosting gate AND the accuracy gate — proving the gates have teeth.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { cachedToolCall, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';
import { FAMILY_TIMEZONE, PARTY_FIXTURES, RECEIVED_AT } from './rsvp-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'party-extraction.md');

/** Mirrors apps/web/lib/party/extract.ts exactly. */
const PARTY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    is_party: { type: 'boolean' },
    title: { type: ['string', 'null'] },
    starts_at: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    child_name: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['is_party', 'confidence'],
};

/** Mirrors MAX_LEAD_MS in apps/web/lib/party/extract.ts. */
const MAX_LEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

const BROKEN_PARTY = {
  is_party: true,
  title: "Charlie's birthday",
  starts_at: '2019-03-01T14:00:00-05:00',
  location: 'Jump Zone Trampoline Park, 88 Queen St W',
  child_name: 'Charlie',
  confidence: 0.99,
};

/** The real request payload, mirroring apps/web/lib/party/extract.ts's partyUserMessage. */
function partyUserMessage(fixture) {
  return JSON.stringify({
    message: fixture.message,
    received_at: RECEIVED_AT,
    timezone: FAMILY_TIMEZONE,
  });
}

/**
 * Every free-text token the model returned must be TRACEABLE to the message it was
 * given. This is the hallucination check for CONTENT: an invented venue or a child who
 * was never named fails here, deterministically.
 *
 * Case- and punctuation-insensitive so "the Park" traces to "the park", and word-wise
 * for the location so a lightly reordered phrase is not scored as an invention while a
 * COMPLETED address (new words the parent never typed) still is.
 */
function fabrications(fixture, value) {
  const haystack = fixture.message.toLowerCase();
  const offenders = [];

  if (typeof value.child_name === 'string' && !haystack.includes(value.child_name.toLowerCase())) {
    offenders.push(`child name "${value.child_name}" appears nowhere in the message`);
  }
  if (typeof value.location === 'string') {
    const invented = value.location
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0 && !haystack.includes(word));
    if (invented.length > 0) {
      offenders.push(`location added words the parent never wrote: ${invented.join(', ')}`);
    }
  }
  return offenders;
}

/**
 * The datetime gate, in the two forms that matter. Applies the SAME window the runtime
 * applies (resolvePartyStart), so a date the eval passes is a date prod would keep.
 */
function datetimeFaults(fixture, value) {
  const faults = [];
  const received = new Date(RECEIVED_AT).getTime();

  if (value.starts_at === null || value.starts_at === undefined) return faults;
  if (value.is_party !== true) {
    faults.push('returned a datetime on a message it said was not a party');
    return faults;
  }

  const parsed = new Date(value.starts_at);
  if (Number.isNaN(parsed.getTime())) {
    faults.push(`starts_at "${value.starts_at}" is not a parseable datetime`);
    return faults;
  }
  if (!/[+-]\d{2}:?\d{2}$/.test(value.starts_at) && !value.starts_at.endsWith('Z')) {
    faults.push(`starts_at "${value.starts_at}" carries no UTC offset`);
  }
  if (parsed.getTime() <= received) {
    faults.push(`starts_at "${value.starts_at}" is at or before the message arrived`);
  }
  if (parsed.getTime() - received > MAX_LEAD_MS) {
    faults.push(`starts_at "${value.starts_at}" is more than two years out`);
  }
  // The refusal fixtures: the message carries no resolvable date, so ANY date is one
  // the model made up.
  if (fixture.expect.startsAt === null) {
    faults.push(`invented "${value.starts_at}" for a message with no resolvable date`);
  }
  return faults;
}

/** Field-by-field against the SPEC-derived expectation. */
function scoreFixture(fixture, value) {
  const failures = [];
  const want = fixture.expect;

  if (value.is_party !== want.isParty) {
    failures.push(`is_party ${value.is_party} != ${want.isParty}`);
    return failures;
  }
  if (want.isParty === false) return failures;

  for (const token of want.titleIncludes ?? []) {
    if (typeof value.title !== 'string' || !value.title.toLowerCase().includes(token.toLowerCase())) {
      failures.push(`title ${JSON.stringify(value.title)} is missing "${token}"`);
    }
  }

  if (want.startsAt === null) {
    if (value.starts_at !== null && value.starts_at !== undefined) {
      failures.push(`starts_at ${JSON.stringify(value.starts_at)} should have been null`);
    }
  } else if (want.startsAt !== undefined) {
    const got = value.starts_at ? new Date(value.starts_at).getTime() : Number.NaN;
    if (got !== new Date(want.startsAt).getTime()) {
      failures.push(`starts_at ${JSON.stringify(value.starts_at)} != ${want.startsAt}`);
    }
  }

  if (want.location !== undefined) {
    const got = typeof value.location === 'string' ? value.location.trim().toLowerCase() : null;
    const expected = want.location === null ? null : want.location.toLowerCase();
    if (got !== expected) {
      failures.push(`location ${JSON.stringify(value.location)} != ${JSON.stringify(want.location)}`);
    }
  }

  if (want.childName !== undefined) {
    const got = typeof value.child_name === 'string' ? value.child_name.trim() : null;
    if (got !== want.childName) {
      failures.push(`child_name ${JSON.stringify(got)} != ${JSON.stringify(want.childName)}`);
    }
  }

  return failures;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);

  console.log(
    `rsvp-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | extract=${model}`,
  );
  console.log(`corpus: ${PARTY_FIXTURES.length} party fixtures | received_at=${RECEIVED_AT}\n`);

  const results = [];
  for (const fixture of PARTY_FIXTURES) {
    const value = broken
      ? BROKEN_PARTY
      : (
          await cachedToolCall({
            tag: `rsvp:extract:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: partyUserMessage(fixture),
            toolName: 'party',
            toolSchema: PARTY_TOOL_SCHEMA,
            toolDescription: 'Return the party the parent described, or is_party false.',
            maxTokens: 512,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    results.push({
      fixture,
      value,
      failures: scoreFixture(fixture, value),
      fabrications: fabrications(fixture, value),
      datetimeFaults: datetimeFaults(fixture, value),
    });
  }

  const passes = results.filter(
    (r) => r.failures.length === 0 && r.fabrications.length === 0 && r.datetimeFaults.length === 0,
  );
  const accuracy = passes.length / results.length;
  const fabricationCount = results.filter((r) => r.fabrications.length > 0).length;
  const datetimeCount = results.filter((r) => r.datetimeFaults.length > 0).length;

  // The gate that matters most: nothing in the hosting battery may read as a party this
  // family is throwing. One is a public page for someone else's child.
  const hostingFalsePositives = results.filter(
    (r) => r.fixture.hostingTrap && r.value.is_party === true,
  );
  // The other direction: a real party read as "not a party" costs the whole feature.
  const hostingFixtures = results.filter((r) => r.fixture.expect.isParty === true);
  const hostingRecall =
    hostingFixtures.filter((r) => r.value.is_party === true).length / (hostingFixtures.length || 1);
  // A refusal fixture read as a date is already counted above; this reports the recall
  // of the refusal itself, which is what earns the ONE clarifying question.
  const refusalFixtures = results.filter((r) => r.fixture.expect.startsAt === null);
  const refusalRecall =
    refusalFixtures.filter((r) => r.value.starts_at === null || r.value.starts_at === undefined)
      .length / (refusalFixtures.length || 1);

  console.log('--- extraction ---');
  for (const r of results) {
    const ok =
      r.failures.length === 0 && r.fabrications.length === 0 && r.datetimeFaults.length === 0;
    const detail = [...r.failures, ...r.fabrications, ...r.datetimeFaults].join('; ');
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.fixture.id}${ok ? '' : `  ${detail}`}`);
  }

  console.log('\n--- corpus metrics ---');
  console.log(`field accuracy:              ${(accuracy * 100).toFixed(1)}%  (>= 85% required)`);
  console.log(`content fabrications:        ${fabricationCount}  (0 required — an invented venue/name)`);
  console.log(`datetime hallucinations:     ${datetimeCount}  (0 required — a date nobody wrote)`);
  console.log(`hosting FALSE POSITIVES:     ${hostingFalsePositives.length}  (0 required — publishing someone else's party)`);
  console.log(`hosting recall:              ${(hostingRecall * 100).toFixed(1)}%  (>= 85% required)`);
  console.log(`date-refusal recall:         ${(refusalRecall * 100).toFixed(1)}%  (100% required)`);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    accuracy >= 0.85 &&
    fabricationCount === 0 &&
    datetimeCount === 0 &&
    hostingFalsePositives.length === 0 &&
    hostingRecall >= 0.85 &&
    refusalRecall === 1;

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
  console.error('rsvp eval harness error:', err);
  process.exit(2);
});
