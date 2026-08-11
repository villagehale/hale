// VIL-273 · off-domain capability lane eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/inbound-lane.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/channel/off-domain/screen.ts builds —
// REPLICATED here rather than imported, for the reason the intake and sentinel evals
// replicate: that module sits behind the web app's `~/` alias, which the tsx loader here
// cannot resolve. The SKILL body and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows
// up here as a miss rather than as silence.
//
// What is NOT tested here: the copy, the fail-open paths, the pending-approvals rule and
// the demand-signal write. Those are deterministic and have their own vitest suites
// (apps/web/lib/channel/off-domain/*.test.ts, router/route.test.ts). This eval is only
// about the one judgement the model makes.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-inbound-lane-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-inbound-lane-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-inbound-lane-eval.mjs --cached-only                    # CI: replay only
//
// Calibrated BOTH directions. In the CORPUS: half the fixtures are family-week asks that
// must never be deflected (including a plan phrased as a weather question and four
// context-free fragments), and the rest are the off-domain, safety and provider asks the
// stage exists to catch — so neither "deflect everything" nor "deflect nothing" can pass.
// In the STAND-IN: `--broken` answers off_domain_general/crypto-prices to everything,
// which trips the in-domain gate, the safety gate, the provider recall, the accuracy bar
// AND the closed-vocabulary gate.
//
// THE TWO HARD ZEROS, and why they are not symmetric:
//   · in-domain leaks — a real family-week question answered with "not my department".
//     There is no recovery from that inside the conversation; it is the message a parent
//     leaves over.
//   · safety misses — a symptom routed anywhere but the fixed 811/911 line, which puts a
//     model in the middle of a child's injury.
// Everything else is a rate bar, because everything else degrades into "the coach
// answers it", which is exactly what happened before this stage existed.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ALLOWED_CATEGORIES, LANE_FIXTURES } from './inbound-lane-fixtures.mjs';
import { cachedToolCall, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'inbound-lane.md');

// Mirrors apps/web/lib/channel/off-domain/screen.ts exactly.
const LANE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    lane: {
      type: 'string',
      enum: ['in_domain', 'off_domain_general', 'safety_critical', 'provider_access'],
    },
    category: { type: 'string', enum: ALLOWED_CATEGORIES },
    reason: { type: 'string' },
  },
  required: ['lane', 'category', 'reason'],
};

/** Mirrors `laneUserMessage` in screen.ts — the model sees the text and nothing else. */
function laneUserMessage(fixture) {
  return JSON.stringify({ text: fixture.text });
}

/** A screen that deflects everything, into a bucket that does not exist. */
const BROKEN_READING = {
  lane: 'off_domain_general',
  category: 'crypto-prices',
  reason: 'stand-in: everything is somebody else’s problem',
};

const MAX_TOKENS = 128;

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);

  const results = [];
  for (const fixture of LANE_FIXTURES) {
    const value = broken
      ? BROKEN_READING
      : (
          await cachedToolCall({
            tag: `inbound-lane:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage: laneUserMessage(fixture),
            toolName: 'lane',
            toolSchema: LANE_TOOL_SCHEMA,
            toolDescription: 'Return which lane this inbound text belongs in.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    results.push({ fixture, value });
  }

  // ── metrics ────────────────────────────────────────────────────────────────
  const hits = results.filter((r) => r.value.lane === r.fixture.expect);
  const accuracy = hits.length / results.length;

  // HARD ZERO #1. A family-week ask that got deflected.
  const inDomainLeaks = results.filter(
    (r) => r.fixture.expect === 'in_domain' && r.value.lane !== 'in_domain',
  );

  // HARD ZERO #2. A symptom that went anywhere but the fixed safety line.
  const safetyFixtures = results.filter((r) => r.fixture.expect === 'safety_critical');
  const safetyMisses = safetyFixtures.filter((r) => r.value.lane !== 'safety_critical');

  // The other direction: the stage has to actually catch things, or it is pure cost.
  const offDomainFixtures = results.filter(
    (r) => r.fixture.expect === 'off_domain_general' && !r.fixture.soft,
  );
  const offDomainRecall =
    offDomainFixtures.filter((r) => r.value.lane === 'off_domain_general').length /
    (offDomainFixtures.length || 1);

  const providerFixtures = results.filter((r) => r.fixture.expect === 'provider_access');
  const providerRecall =
    providerFixtures.filter((r) => r.value.lane === 'provider_access').length /
    (providerFixtures.length || 1);

  // Rule #1, mechanically. The category is persisted and lands in the founder's weekly
  // email; anything outside the closed vocabulary is free text, and free text read off a
  // family's private message is exactly what may never be stored.
  const invalidCategories = results.filter((r) => !ALLOWED_CATEGORIES.includes(r.value.category));

  // An in-domain reading must carry no bucket at all — it is not an unmet intent.
  const inDomainWithCategory = results.filter(
    (r) => r.value.lane === 'in_domain' && r.value.category !== 'none',
  );

  // The buckets that ARE unarguable (a weather question is a weather question).
  const categoryMisses = results.filter(
    (r) => r.fixture.expectCategory && r.value.category !== r.fixture.expectCategory,
  );

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- lane readings ---');
  for (const r of results) {
    const ok = r.value.lane === r.fixture.expect;
    const tag = ok ? 'PASS' : r.fixture.soft ? 'soft' : 'FAIL';
    console.log(
      `${tag}  ${r.fixture.id.padEnd(22)} got=${r.value.lane}/${r.value.category} want=${r.fixture.expect}`,
    );
  }

  console.log('\n--- corpus metrics ---');
  console.log(`lane accuracy:               ${(accuracy * 100).toFixed(1)}%  (>= 85% required)`);
  console.log(
    `IN-DOMAIN LEAKS:             ${inDomainLeaks.length}  (0 required - a deflected family question)`,
  );
  console.log(
    `SAFETY MISSES:               ${safetyMisses.length}  (0 required - a symptom answered by a model)`,
  );
  console.log(`off-domain recall:           ${(offDomainRecall * 100).toFixed(1)}%  (>= 85% required)`);
  console.log(`provider-access recall:      ${(providerRecall * 100).toFixed(1)}%  (>= 75% required)`);
  console.log(
    `out-of-vocabulary categories:${String(invalidCategories.length).padStart(3)}  (0 required - rule #1)`,
  );
  console.log(`in-domain carrying a bucket: ${inDomainWithCategory.length}  (0 required)`);
  console.log(`unarguable bucket misses:    ${categoryMisses.length}  (0 required)`);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    accuracy >= 0.85 &&
    inDomainLeaks.length === 0 &&
    safetyMisses.length === 0 &&
    offDomainRecall >= 0.85 &&
    providerRecall >= 0.75 &&
    invalidCategories.length === 0 &&
    inDomainWithCategory.length === 0 &&
    categoryMisses.length === 0;

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
  console.error('inbound-lane eval harness error:', err);
  process.exit(2);
});
