#!/usr/bin/env node
// VIL-376 · Can Jev replace Sonnet for the bounded intake consent decision?
//
// This runs the existing reply-intent corpus through Jev's native Choice API.
// It does not change production routing. The parent's verbatim reply remains a
// deterministic passthrough; Jev decides only assent / decline / ambiguous.
//
// Run from apps/worker:
//   node --env-file=../../launch.env evals/run-jev-intent-eval.mjs
//   node --env-file=../../launch.env evals/run-jev-intent-eval.mjs --compare-sonnet
//   node evals/run-jev-intent-eval.mjs --cached-only --compare-sonnet
//   node evals/run-jev-intent-eval.mjs --compare-sonnet --preflight
//   node evals/run-jev-intent-eval.mjs --broken

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { INTENT_FIXTURES, INTENT_QUESTION } from './intake-fixtures.mjs';
import { cacheGet, cacheKey, cachePut, evalRunTag, lazyAnthropic } from './lib/harness.mjs';
import { REPLY_INTENT_HELD_OUT_FIXTURES } from './reply-intent-held-out-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const INTENT_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'reply-intent.md');
const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate';
const MODEL = 'typesafe-ai/jev';
const INTENTS = ['assent', 'decline', 'ambiguous'];
const MAX_TOKENS = 256;

const INTENT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    verbatim: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['intent', 'verbatim', 'rationale', 'confidence'],
};

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(quantile * ordered.length) - 1];
}

function numberOrNull(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function evaluateFixture({ fixture, instructions, cachedOnly }) {
  const request = {
    model: MODEL,
    state: { question: INTENT_QUESTION, reply: fixture.reply },
    questions: {
      intent: {
        type: 'choice',
        instructions,
        criteria: {
          assent: 'The assent category defined in the instructions.',
          decline: 'The decline category defined in the instructions.',
          ambiguous: 'The ambiguous category defined in the instructions.',
        },
      },
    },
  };
  const key = cacheKey(evalRunTag(`jev:intake-intent:${fixture.id}`), JSON.stringify(request));
  const cached = await cacheGet(key);
  if (cached) return { ...cached, cached: true };

  if (cachedOnly) {
    throw new Error(
      `cache miss for ${fixture.id} (${key}); run live once with --env-file to populate it`,
    );
  }

  const apiKey = process.env.VERCEL_KEY ?? process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error('Set VERCEL_KEY or AI_GATEWAY_API_KEY');

  const startedAt = performance.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  const latencyMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    throw new Error(`Jev request failed (${response.status}): ${JSON.stringify(result)}`);
  }

  const choice = result.answers?.intent?.choice;
  if (!INTENTS.includes(choice)) {
    throw new Error(`Unexpected Jev intent for ${fixture.id}: ${JSON.stringify(result.answers)}`);
  }

  const record = {
    choice,
    probabilities: result.answers.intent.probabilities ?? {},
    latencyMs,
    usage: result.usage ?? null,
    costUsd: numberOrNull(result.providerMetadata?.gateway?.cost),
    confidence:
      result.providerMetadata?.typesafe?.confidence?.intent ??
      result.providerMetadata?.typesafe?.confidence ??
      null,
  };
  await cachePut(key, record);
  return { ...record, cached: false };
}

async function evaluateSonnetFixture({ fixture, skill, agent, cachedOnly, getClient }) {
  const lane = agent.pickLane(skill.meta.task);
  const userMessage = JSON.stringify({ question: INTENT_QUESTION, reply: fixture.reply });
  const request = {
    ...agent.laneRequestFields(lane),
    max_tokens: MAX_TOKENS,
    system: skill.instructions,
    tools: [
      {
        name: 'intent',
        description: "Return how the parent's reply reads.",
        input_schema: INTENT_TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'intent' },
    messages: [{ role: 'user', content: userMessage }],
  };
  const key = cacheKey(
    evalRunTag(`sonnet:intake-intent-comparison:${fixture.id}`),
    JSON.stringify(request),
  );
  const cached = await cacheGet(key);
  if (cached) return { ...cached, cached: true };

  if (cachedOnly) {
    throw new Error(
      `Sonnet cache miss for ${fixture.id} (${key}); run live once with --env-file to populate it`,
    );
  }

  const startedAt = performance.now();
  const response = await getClient().messages.create(request);
  const latencyMs = Math.round(performance.now() - startedAt);
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Sonnet intent call truncated for ${fixture.id}`);
  }
  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === 'intent',
  );
  const value = toolUse?.input;
  if (!value || !INTENTS.includes(value.intent)) {
    throw new Error(`Unexpected Sonnet intent for ${fixture.id}: ${JSON.stringify(value)}`);
  }

  const usage = {
    inputTokens: response.usage.input_tokens,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
  };
  const record = {
    choice: value.intent,
    verbatimCorrect: value.verbatim === fixture.reply,
    latencyMs,
    usage,
    costUsd: agent.estimateCostUsd(lane.model, usage),
    confidence: typeof value.confidence === 'number' ? value.confidence : null,
  };
  await cachePut(key, record);
  return { ...record, cached: false };
}

function summarize(results) {
  const latency = results.map((result) => result.latencyMs);
  const costs = results.map((result) => result.costUsd).filter((cost) => cost !== null);
  const totalCost =
    costs.length === results.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  return {
    accuracy:
      results.filter((result) => result.choice === result.fixture.expect).length / results.length,
    p50: percentile(latency, 0.5),
    p95: percentile(latency, 0.95),
    totalCost,
    costPerThousand: totalCost === null ? null : (totalCost / results.length) * 1000,
  };
}

function printComparison(jevResults, sonnetResults) {
  const jev = summarize(jevResults);
  const sonnet = summarize(sonnetResults);
  const disagreements = jevResults.filter(
    (result, index) => result.choice !== sonnetResults[index]?.choice,
  );
  console.info('\n--- Jev vs Sonnet 5: intake reply-intent ---');
  console.info('model       accuracy  p50     p95     total USD   USD / 1k');
  for (const [name, summary] of [
    ['Jev', jev],
    ['Sonnet 5', sonnet],
  ]) {
    console.info(
      `${name.padEnd(11)} ${(summary.accuracy * 100).toFixed(1).padStart(6)}%  ${`${summary.p50}ms`.padStart(6)}  ${`${summary.p95}ms`.padStart(6)}  ${summary.totalCost?.toFixed(6).padStart(10) ?? '       n/a'}  ${summary.costPerThousand?.toFixed(4).padStart(8) ?? '     n/a'}`,
    );
  }
  console.info(`paired choice disagreements: ${disagreements.length}`);
  console.info(
    `Jev delta: p50 ${jev.p50 - sonnet.p50}ms, p95 ${jev.p95 - sonnet.p95}ms, cost/1k $${(jev.costPerThousand - sonnet.costPerThousand).toFixed(4)}`,
  );
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const compareSonnet = process.argv.includes('--compare-sonnet');
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1];
  const preflight = process.argv.includes('--preflight');
  const broken = process.argv.includes('--broken');
  const heldOut = process.argv.includes('--held-out');
  if (broken && (cachedOnly || compareSonnet)) {
    throw new Error(
      '--broken is offline; do not combine it with --cached-only or --compare-sonnet',
    );
  }
  const corpus = heldOut ? REPLY_INTENT_HELD_OUT_FIXTURES : INTENT_FIXTURES;
  const selectedIds = new Set(only?.split(',').filter(Boolean) ?? []);
  const fixtures = only ? corpus.filter((fixture) => selectedIds.has(fixture.id)) : corpus;
  if (fixtures.length !== (only ? selectedIds.size : corpus.length)) {
    throw new Error(`one or more fixtures did not match --only=${only}`);
  }
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const skill = await agent.loadSkill(INTENT_SKILL_PATH);
  const instructions = `${skill.instructions}\n\nClassify the reply in state using exactly one of the three criteria.`;

  console.info(
    `jev-intent-eval | ${broken ? 'broken' : cachedOnly ? 'cached-only' : 'live'} | corpus=${heldOut ? 'held-out' : 'development'} | ${fixtures.length} fixtures | sonnet=${compareSonnet ? 'compare' : 'skip'}`,
  );
  if (preflight) {
    console.info(
      `preflight: max live calls=${fixtures.length * (compareSonnet ? 2 : 1)} (${fixtures.length} Jev${compareSonnet ? ` + ${fixtures.length} Sonnet` : ''})`,
    );
    return;
  }

  const results = [];
  for (const fixture of fixtures) {
    const outcome = broken
      ? { choice: 'assent', latencyMs: 0, usage: null, costUsd: 0, confidence: 1, cached: true }
      : await evaluateFixture({ fixture, instructions, cachedOnly });
    results.push({ fixture, ...outcome });
    console.info(
      `${outcome.choice === fixture.expect ? 'PASS' : 'FAIL'}  ${fixture.id}  got=${outcome.choice} want=${fixture.expect}  ${outcome.latencyMs}ms${outcome.cached ? ' cached' : ''}`,
    );
  }

  const hits = results.filter((result) => result.choice === result.fixture.expect);
  const accuracy = hits.length / results.length;
  const assentFixtures = results.filter((result) => result.fixture.expect === 'assent');
  const assentRecall =
    assentFixtures.filter((result) => result.choice === 'assent').length /
    (assentFixtures.length || 1);
  const consentFalsePositives = results.filter(
    (result) => result.fixture.falsePositive && result.choice === 'assent',
  );
  const declineAsAssent = results.filter(
    (result) => result.fixture.expect === 'decline' && result.choice === 'assent',
  );
  const latency = results.map((result) => result.latencyMs);
  const reportedCosts = results.map((result) => result.costUsd).filter((cost) => cost !== null);
  const liveCalls = results.filter((result) => !result.cached).length;

  console.info('\n--- corpus metrics ---');
  console.info(`intent accuracy:         ${(accuracy * 100).toFixed(1)}%  (>= 98% required)`);
  console.info(`assent recall:           ${(assentRecall * 100).toFixed(1)}%  (>= 95% required)`);
  console.info(
    `consent false positives: ${consentFalsePositives.length}  (0 required — a manufactured consent)`,
  );
  console.info(`declines read as assent: ${declineAsAssent.length}  (0 required)`);
  console.info(
    `recorded latency p50/p95: ${percentile(latency, 0.5)}ms / ${percentile(latency, 0.95)}ms`,
  );
  console.info(`live API calls this run: ${liveCalls}`);
  console.info(
    reportedCosts.length === results.length
      ? `gateway-reported cost: $${reportedCosts.reduce((sum, cost) => sum + cost, 0).toFixed(6)} USD`
      : `gateway-reported cost: unavailable for ${results.length - reportedCosts.length}/${results.length} calls`,
  );

  if (compareSonnet) {
    const getClient = lazyAnthropic();
    const sonnetResults = [];
    for (const fixture of fixtures) {
      const outcome = await evaluateSonnetFixture({
        fixture,
        skill,
        agent,
        cachedOnly,
        getClient,
      });
      sonnetResults.push({ fixture, ...outcome });
    }
    printComparison(results, sonnetResults);
  }

  const allPass =
    accuracy >= 0.98 &&
    assentRecall >= 0.95 &&
    consentFalsePositives.length === 0 &&
    declineAsAssent.length === 0;
  if (broken) {
    const calibrated = !allPass;
    console.info(
      `\n${calibrated ? 'PASS' : 'FAIL'} — broken-mode calibration (all-assent classifier must fail)`,
    );
    if (!calibrated) process.exitCode = 1;
    return;
  }
  console.info(`\n${allPass ? 'PASS' : 'FAIL'} — Jev intake intent gate`);
  if (!allPass) process.exitCode = 1;
}

await main();
