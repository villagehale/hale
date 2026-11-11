// VIL-360 · weekday-care ask eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/weekday-care-ask.md, called the way the runtime calls it
// (apps/web/lib/channel/nudge/nudge-voice.ts): the `weekday_ask` tool forced on the
// skill's lane, then the runtime's own check (readWeekdayAsk). The grade is the text a
// parent would read.
//
// The model picks the words, so nothing here counts question marks, demands a word or
// bans a phrase. Deterministic gates are kept only for what is never the model's call:
// a word for the parent to reply with, and the language where a reader exists for it.
// Whether the text is the chosen offer, about the right child or break, carries one ask,
// claims nothing Hale has not done and reads like a friend texting is the judge's grade.
//
//   ANTHROPIC_API_KEY=... node evals/run-weekday-care-ask-eval.mjs   # live, populates the cache
//   node evals/run-weekday-care-ask-eval.mjs --cached-only           # CI: replay, zero API calls

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { capSdkClient, installSpendCap, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import {
  JUDGE_MIN,
  JUDGE_SCHEMA,
  REPO_ROOT,
  cacheGet,
  cacheKey,
  evalRunTag,
  isVerdict,
  lazyAnthropic,
  makeCost,
  makeJudge,
  priceRates,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import { cachedLaneToolCall, laneToolCacheKey } from './lib/lane-tool-call.mjs';
import { WEEKDAY_CARE_ASK_FIXTURES } from './weekday-care-ask-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'weekday-care-ask.md');
const TOOLS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'nudge', 'weekday-ask-tools.ts');
/** A reply word the founder rules forbid Hale to teach. */
const KEYWORD_TEACHING = ['reply yes', 'reply no', 'text yes'];

const JUDGE_SYSTEM = judgePrompt('weekday-care-ask');

function grade(_fixture, written, verdict) {
  if ('skipped' in written) return [`refused by the runtime check: ${written.skipped}`];
  const failures = [];
  const body = written.message.toLowerCase();
  for (const phrase of KEYWORD_TEACHING) {
    if (body.includes(phrase)) failures.push(`teaches the reply word "${phrase}"`);
  }
  if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
  return failures;
}

function judgeCeiling(model) {
  return String(model).includes('haiku') ? 4096 : 8192;
}

/**
 * Cache misses only. A subject miss prices the judge too. The draft lane thinks
 * between tools, so the subject adds no thinking tokens.
 */
export async function uncachedWeekdayCalls(judgeOutputChars) {
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const measured = [];
  const calls = [];
  const shortIds = [];
  for (const fixture of WEEKDAY_CARE_ASK_FIXTURES) {
    const userMessage = tools.weekdayAskContext(fixture.ask, fixture.language);
    const key = laneToolCacheKey({
      agent,
      lane,
      tag: evalRunTag(`weekday-care-ask:${fixture.id}`),
      system: skill.instructions,
      userMessage,
      toolName: tools.WEEKDAY_ASK_TOOL,
      toolSchema: tools.WEEKDAY_ASK_TOOL_SCHEMA,
      maxTokens: tools.WEEKDAY_ASK_MAX_TOKENS,
    });
    const cached = await cacheGet(key);
    let message = null;
    if (cached) {
      measured.push(JSON.stringify(cached.value).length);
      const written = tools.readWeekdayAsk(cached.value, fixture.ask);
      if ('message' in written) message = written.message;
    } else {
      shortIds.push(fixture.id);
      calls.push({
        model: lane.model,
        promptCache: false,
        prefixId: 'weekday-care-ask',
        prefix: `${skill.instructions}\n${JSON.stringify(tools.WEEKDAY_ASK_TOOL_SCHEMA)}`,
        user: userMessage,
        thinkingTokens: 0,
        group: 'weekday-care-ask',
        maxTokens: tools.WEEKDAY_ASK_MAX_TOKENS,
        fixtureId: fixture.id,
      });
    }
    if (cached && message === null) continue;
    const text = message ?? 'A short offer about the week.';
    const judgeUser = JSON.stringify({ context: JSON.parse(userMessage), text });
    const judgeKey = cacheKey(
      `weekday-care-ask:judge:${fixture.id}`,
      `${judgeModel}\n${JUDGE_SYSTEM}\n${judgeUser}`,
    );
    const judged = message === null ? null : await cacheGet(judgeKey);
    if (judged && isVerdict(judged.parsed)) continue;
    calls.push({
      model: judgeModel,
      promptCache: true,
      prefixId: 'weekday-care-ask-judge',
      prefix: `${JUDGE_SYSTEM}\n${JSON.stringify(JUDGE_SCHEMA)}`,
      user: judgeUser,
      outputChars: judgeOutputChars,
      thinkingTokens: 0,
      group: 'weekday-care-ask',
      maxTokens: judgeCeiling(judgeModel),
      fixtureId: fixture.id,
    });
  }
  const outputChars = measured.length
    ? [...measured].sort((a, b) => a - b)[Math.ceil(measured.length / 2) - 1]
    : 400;
  return {
    calls: calls.map((call) => (call.outputChars === undefined ? { ...call, outputChars } : call)),
    shortIds,
    outputChars,
    model: lane.model,
    judgeModel,
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
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const rawClient = lazyAnthropic();
  const getClient = () => capSdkClient(rawClient(), { rates: priceRates, tag: 'weekday-care-ask' });
  const cost = makeCost();
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'weekday-care-ask',
    cachedOnly,
    getClient,
    cost,
  );

  console.info(
    `weekday-care-ask | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} judge=${judgeModel} | fixtures=${WEEKDAY_CARE_ASK_FIXTURES.length}`,
  );
  const misses = [];
  let failed = 0;
  for (const fixture of WEEKDAY_CARE_ASK_FIXTURES) {
    const context = tools.weekdayAskContext(fixture.ask, fixture.language);
    const call = await cachedLaneToolCall({
      agent,
      lane,
      tag: evalRunTag(`weekday-care-ask:${fixture.id}`),
      system: skill.instructions,
      userMessage: context,
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
    const verdict =
      'message' in written
        ? await judge(fixture.id, { context: JSON.parse(context), text: written.message })
        : null;
    const failures = grade(fixture, written, verdict);
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
