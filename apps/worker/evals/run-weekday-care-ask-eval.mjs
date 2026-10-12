// VIL-360 · weekday-care ask eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/weekday-care-ask.md, called the way the runtime calls it
// (apps/web/lib/channel/nudge/nudge-voice.ts): the `weekday_ask` tool forced on the
// skill's lane, then the runtime's own check (readWeekdayAsk). The grade is the text a
// parent would read.
//
//   ANTHROPIC_API_KEY=... node evals/run-weekday-care-ask-eval.mjs   # live, populates the cache
//   node evals/run-weekday-care-ask-eval.mjs --cached-only           # CI: replay, zero API calls

import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { REPO_ROOT, evalRunTag, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';
import { cachedLaneToolCall } from './lib/lane-tool-call.mjs';
import { WEEKDAY_CARE_ASK_FIXTURES } from './weekday-care-ask-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'weekday-care-ask.md');
const TOOLS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'nudge', 'weekday-ask-tools.ts');

/** Filler the skill forbids by name, and a reply word the founder rules forbid. */
const FORBIDDEN = ['just checking in', 'hope this helps', 'reply yes', 'reply no', 'text yes'];

function grade(fixture, written) {
  if ('skipped' in written) return [`refused by the runtime check: ${written.skipped}`];
  const failures = [];
  const body = written.message.toLowerCase();
  for (const word of fixture.expect.mentions) {
    if (!body.includes(word)) failures.push(`never says "${word}"`);
  }
  for (const phrase of FORBIDDEN) {
    if (body.includes(phrase)) failures.push(`forbidden "${phrase}"`);
  }
  if (!written.message.trimEnd().endsWith('?')) failures.push('the offer does not end the text');
  return failures;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  console.info(
    `weekday-care-ask | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} | fixtures=${WEEKDAY_CARE_ASK_FIXTURES.length}`,
  );
  const misses = [];
  let failed = 0;
  for (const fixture of WEEKDAY_CARE_ASK_FIXTURES) {
    const call = await cachedLaneToolCall({
      agent,
      lane,
      tag: evalRunTag(`weekday-care-ask:${fixture.id}`),
      system: skill.instructions,
      userMessage: tools.weekdayAskContext(fixture.ask),
      toolName: tools.WEEKDAY_ASK_TOOL,
      toolDescription: 'The one text Hale sends.',
      toolSchema: tools.WEEKDAY_ASK_TOOL_SCHEMA,
      maxTokens: tools.WEEKDAY_ASK_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const written = tools.readWeekdayAsk(call.value, fixture.ask);
    const failures = grade(fixture, written);
    if (failures.length > 0) failed += 1;
    console.info(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    if ('message' in written) console.info(`        > ${written.message}`);
    for (const failure of failures) console.info(`        - ${failure}`);
  }
  if (misses.length > 0) {
    console.error(`weekday-care-ask: ${misses.length} cache miss(es) in --cached-only`);
    for (const miss of misses) console.error(`  ${miss}`);
    process.exit(1);
  }
  const passed = WEEKDAY_CARE_ASK_FIXTURES.length - failed;
  console.info(
    `\n${passed}/${WEEKDAY_CARE_ASK_FIXTURES.length} passed | live API calls: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
