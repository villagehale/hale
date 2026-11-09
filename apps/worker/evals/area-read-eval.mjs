// VIL-546 · Area read eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/area-read.md, called the way the runtime calls it
// (apps/web/lib/channel/named-area.ts): the same user message, tool, schema, lane and
// max_tokens, imported from that file. The grade runs the runtime's own gate
// (`searchableArea`) on the model's reading and checks the structured outcome: refused,
// or searched with the expected locality and region. No wording is graded.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up, and it
// runs cached-only in ci.yml (eval:area-read). A miss never spends.
//
//   node evals/area-read-eval.mjs --dry           # worst-case price to record; no API, nothing written
//   node evals/area-read-eval.mjs --cached-only   # replay; a miss exits 1
//   node evals/area-read-eval.mjs --broken        # calibration: a known-bad reading must FAIL (exit 1)
//   node --env-file=../../.env evals/area-read-eval.mjs --record --max-usd 0.10   # live, then caches

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { AREA_READ_FIXTURES, AREA_READ_HOUSEHOLD } from './area-read-fixtures.mjs';
import {
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'area-read.md');
const AREA_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'named-area.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Known-bad on purpose: every place read as one town, streets included. */
const BROKEN_READING = { locality: 'Springfield', region: null, granularity: 'locality' };

const fold = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function fieldMatches(actual, accepted) {
  if (accepted === null) return actual === null;
  return actual !== null && accepted.some((spelling) => fold(spelling) === fold(actual));
}

/** Why this outcome is wrong for this fixture; empty when it is right. */
export function gradeAreaOutcome(expect, outcome) {
  if (expect.refusal) {
    return outcome.ok ? [`searched "${outcome.label}", expected ${expect.refusal}`] : [];
  }
  if (!outcome.ok) return [`refused ${outcome.refusal}, expected a search`];
  const failures = [];
  if (!fieldMatches(outcome.area.locality, expect.locality)) {
    failures.push(`locality=${JSON.stringify(outcome.area.locality)}`);
  }
  if (!fieldMatches(outcome.area.region, expect.region)) {
    failures.push(`region=${JSON.stringify(outcome.area.region)}`);
  }
  return failures;
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 3);
}

function worstCaseUsd({ lane, skill, area }) {
  const price = PRICE[lane.model];
  if (!price) throw new Error(`no list price for ${lane.model}`);
  let usd = 0;
  for (const fixture of AREA_READ_FIXTURES) {
    const input =
      estimateTokens(skill.instructions) +
      estimateTokens(area.areaReadUserMessage(fixture.text)) +
      estimateTokens(area.AREA_READ_TOOL_SCHEMA);
    usd += (input / 1e6) * price.input + (area.AREA_READ_MAX_TOKENS / 1e6) * price.output;
  }
  return usd;
}

function report(results) {
  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(32)} ${r.outcome.ok ? `searched "${r.outcome.label}"` : `refused ${r.outcome.refusal}`}`,
    );
    for (const f of r.failures) console.info(`      · ${f}`);
  }
  return results.every((r) => r.failures.length === 0);
}

async function main() {
  const dry = process.argv.includes('--dry');
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const record = process.argv.includes('--record');
  if ([dry, broken, cachedOnly, record].filter(Boolean).length !== 1) {
    console.error(
      'area-read: pass exactly one of --dry, --cached-only, --broken or --record. Only --record calls the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const area = await importTs(AREA_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);

  if (dry) {
    const usd = worstCaseUsd({ lane, skill, area });
    console.info(
      `area-read: worst case to record ${AREA_READ_FIXTURES.length} fixtures (${lane.model}), every call at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
    );
    return;
  }

  if (broken) {
    const results = AREA_READ_FIXTURES.map((fixture) => {
      const outcome = area.searchableArea(BROKEN_READING, AREA_READ_HOUSEHOLD);
      return { fixture, outcome, failures: gradeAreaOutcome(fixture.expect, outcome) };
    });
    const passed = report(results);
    console.info('area-read --broken: live API calls: 0.');
    process.exit(passed ? 0 : 1);
  }

  if (record) installEvalSpendCap();
  const getClient = lazyAnthropic('area-read');
  const cost = makeCost();
  console.info(
    `area-read eval | mode=${record ? 'record' : 'cached-only'} | subject=${lane.model}`,
  );
  const results = [];
  for (const fixture of AREA_READ_FIXTURES) {
    const { value } = await cachedToolCall({
      tag: `area-read:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: area.areaReadUserMessage(fixture.text),
      toolName: area.AREA_READ_TOOL,
      toolSchema: area.AREA_READ_TOOL_SCHEMA,
      toolDescription: area.AREA_READ_TOOL_DESCRIPTION,
      maxTokens: area.AREA_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const outcome = area.searchableArea(value, AREA_READ_HOUSEHOLD);
    results.push({ fixture, outcome, failures: gradeAreaOutcome(fixture.expect, outcome) });
  }
  const passed = report(results);
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('area-read eval harness error:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
