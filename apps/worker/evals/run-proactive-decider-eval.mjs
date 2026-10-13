// VIL-226 · proactive decider eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/proactive-decider.md, called the way the runtime calls
// it (apps/web/lib/channel/proactive/decide.ts): the skill as system, the snapshot as the
// user message, the `proactive_decision` tool forced on the skill's lane. The tool
// schema and the parse are imported from the runtime's own tools.ts, and `localNow` is
// rendered by the runtime's own formatter, so neither can drift from production.
//
//   ANTHROPIC_API_KEY=... node evals/run-proactive-decider-eval.mjs   # live, populates the cache
//   node evals/run-proactive-decider-eval.mjs --cached-only           # CI: replay, zero API calls

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { capSdkClient, installSpendCap, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import {
  REPO_ROOT,
  cacheGet,
  evalRunTag,
  lazyAnthropic,
  makeCost,
  priceRates,
  totalUsd,
} from './lib/harness.mjs';
import { cachedLaneToolCall, laneToolCacheKey } from './lib/lane-tool-call.mjs';
import { PROACTIVE_DECIDER_FIXTURES } from './proactive-decider-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'proactive-decider.md');
const PROACTIVE = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'proactive');
const TOOLS_SRC = join(PROACTIVE, 'tools.ts');
const DATETIME_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'format', 'datetime.ts');
const THURSDAY_EVENING = 'Thursday 6:00 PM America/New_York';

/** The weekend fixtures are about Thursday evening; fail loudly if the clock moved. */
function assertThursdayEvening(formatSnapshotLocalNow) {
  for (const id of ['empty-weekend', 'weekend-and-deadline']) {
    const fixture = PROACTIVE_DECIDER_FIXTURES.find((item) => item.id === id);
    if (!fixture) throw new Error(`missing decider fixture ${id}`);
    const localNow = formatSnapshotLocalNow(
      new Date(fixture.snapshot.now),
      fixture.snapshot.timeZone,
    );
    if (localNow !== THURSDAY_EVENING) {
      throw new Error(`${id} localNow is ${localNow}, expected ${THURSDAY_EVENING}`);
    }
    if (fixture.expect.action !== 'send_now') {
      throw new Error(`${id} at ${THURSDAY_EVENING} must expect send_now`);
    }
  }
}

function grade(fixture, decision) {
  if (!decision) return ['answer did not parse'];
  const failures = [];
  const want = fixture.expect;
  if (want.action && decision.action !== want.action) {
    failures.push(`action ${decision.action} !== ${want.action}`);
  }
  if (want.actionIn && !want.actionIn.includes(decision.action)) {
    failures.push(`action ${decision.action} not in ${want.actionIn.join('|')}`);
  }
  for (const id of want.includes ?? []) {
    if (!decision.itemIds.includes(id)) failures.push(`missing item ${id}`);
  }
  for (const id of want.excludes ?? []) {
    if (decision.itemIds.includes(id)) failures.push(`included ${id}`);
  }
  if (want.exact) {
    const got = [...decision.itemIds].sort().join('|');
    const expected = [...(want.includes ?? [])].sort().join('|');
    if (got !== expected) failures.push(`items ${got} !== ${expected}`);
  }
  const offered = new Set(fixture.snapshot.candidates.map((item) => item.id));
  for (const id of decision.itemIds) {
    if (!offered.has(id)) failures.push(`invented item ${id}`);
  }
  const direction = decision.frequencyPreference?.direction ?? null;
  if (want.frequency && direction !== want.frequency) {
    failures.push(`frequency ${direction} !== ${want.frequency}`);
  }
  if (want.frequency === null && direction !== null) {
    failures.push(`set a frequency preference (${direction}) nobody asked for`);
  }
  return failures;
}

/** Cache misses only. The draft lane thinks between tools, so no thinking tokens are added. */
export async function uncachedDeciderCalls() {
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const { formatSnapshotLocalNow } = await tsImport(DATETIME_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const measured = [];
  const pending = [];
  const shortIds = [];
  for (const fixture of PROACTIVE_DECIDER_FIXTURES) {
    const { timeZone, now, ...rest } = fixture.snapshot;
    const userMessage = JSON.stringify({
      timeZone,
      now,
      localNow: formatSnapshotLocalNow(new Date(now), timeZone),
      ...rest,
    });
    const key = laneToolCacheKey({
      agent,
      lane,
      tag: evalRunTag(`proactive-decider:${fixture.id}`),
      system: skill.instructions,
      userMessage,
      toolName: tools.DECIDER_TOOL,
      toolSchema: tools.DECIDER_TOOL_SCHEMA,
      maxTokens: tools.DECIDER_MAX_TOKENS,
    });
    const cached = await cacheGet(key);
    if (cached) {
      measured.push(JSON.stringify(cached.value).length);
      continue;
    }
    shortIds.push(fixture.id);
    pending.push({
      model: lane.model,
      promptCache: false,
      prefixId: 'proactive-decider',
      prefix: `${skill.instructions}\n${JSON.stringify(tools.DECIDER_TOOL_SCHEMA)}`,
      user: userMessage,
      thinkingTokens: 0,
      group: 'proactive-decider',
      maxTokens: tools.DECIDER_MAX_TOKENS,
      fixtureId: fixture.id,
    });
  }
  const outputChars = measured.length
    ? [...measured].sort((a, b) => a - b)[Math.ceil(measured.length / 2) - 1]
    : 400;
  return {
    calls: pending.map((call) => ({ ...call, outputChars })),
    shortIds,
    outputChars,
    model: lane.model,
  };
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const cap = installSpendCap(process.argv);
  if (cap !== null) {
    const ledger = readLedger();
    console.info(
      `spend cap $${cap.toFixed(4)} | already spent $${ledger.spentUsd.toFixed(4)} | ${process.env.HALE_SPEND_LEDGER}`,
    );
  }
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const { formatSnapshotLocalNow } = await tsImport(DATETIME_SRC, import.meta.url);
  assertThursdayEvening(formatSnapshotLocalNow);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const rawClient = lazyAnthropic();
  const getClient = () =>
    capSdkClient(rawClient(), { rates: priceRates, tag: 'proactive-decider' });
  const cost = makeCost();

  console.info(
    `proactive-decider | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} | fixtures=${PROACTIVE_DECIDER_FIXTURES.length}`,
  );
  const misses = [];
  let failed = 0;
  for (const fixture of PROACTIVE_DECIDER_FIXTURES) {
    const { timeZone, now, ...rest } = fixture.snapshot;
    const snapshot = {
      timeZone,
      now,
      localNow: formatSnapshotLocalNow(new Date(now), timeZone),
      ...rest,
    };
    const call = await cachedLaneToolCall({
      agent,
      lane,
      tag: evalRunTag(`proactive-decider:${fixture.id}`),
      system: skill.instructions,
      userMessage: JSON.stringify(snapshot),
      toolName: tools.DECIDER_TOOL,
      toolDescription: 'Your one decision for this family right now.',
      toolSchema: tools.DECIDER_TOOL_SCHEMA,
      maxTokens: tools.DECIDER_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const failures = grade(fixture, tools.parseDeciderDecision(call.value));
    if (failures.length > 0) failed += 1;
    console.info(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    for (const failure of failures) console.info(`        - ${failure}`);
  }
  if (misses.length > 0) {
    console.error(`proactive-decider: ${misses.length} cache miss(es) in --cached-only`);
    for (const miss of misses) console.error(`  ${miss}`);
    process.exit(1);
  }
  const passed = PROACTIVE_DECIDER_FIXTURES.length - failed;
  console.info(
    `\n${passed}/${PROACTIVE_DECIDER_FIXTURES.length} passed | live API calls: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (failed > 0) process.exit(1);
}

function runningAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
