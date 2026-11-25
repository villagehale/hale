// VIL-226 · proactive writer eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/proactive-writer.md, called the way the runtime calls it
// (apps/web/lib/channel/proactive/compose.ts): the `proactive_text` tool forced on the
// skill's lane, then the runtime's own grounding check and link rule (readWriterText).
// The grade is the text a parent would read.
//
// The model picks the words, so nothing here counts question marks, bans a phrase or
// demands a character set. The URL and the activity's own name are checked exactly;
// one ask per text and the tone are the judge's grade.
//
//   ANTHROPIC_API_KEY=... node evals/run-proactive-writer-eval.mjs   # live, populates the cache
//   node evals/run-proactive-writer-eval.mjs --cached-only           # CI: replay, zero API calls

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
import { PROACTIVE_WRITER_FIXTURES } from './proactive-writer-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'proactive-writer.md');
const ADDENDUM_PATH = join(
  REPO_ROOT,
  'packages',
  'agent',
  'skills',
  'proactive-writer-no-repeat.md',
);
const TOOLS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'proactive', 'tools.ts');

const JUDGE_SYSTEM = judgePrompt('proactive-writer');
const REPEAT_JUDGE_SYSTEM = judgePrompt('proactive-repeat');

function repeats(fixture) {
  return Array.isArray(fixture.recentTexts) && fixture.recentTexts.length > 0;
}

async function writerPrompt(fixture, agent, tools) {
  const skill = await agent.loadSkill(SKILL_PATH);
  const guard = repeats(fixture);
  let system = skill.instructions;
  if (guard) {
    const addendum = await agent.loadSkill(ADDENDUM_PATH);
    system = `${skill.instructions}\n\n${addendum.instructions}`;
  }
  return {
    lane: agent.pickLane(skill.meta.task),
    system,
    userMessage: tools.writerContext(
      fixture.items,
      fixture.cadenceNote,
      null,
      guard ? fixture.recentTexts : [],
    ),
    toolSchema: guard ? tools.WRITER_TOOL_SCHEMA_OR_NOTHING : tools.WRITER_TOOL_SCHEMA,
    guard,
  };
}

function grade(fixture, written, verdict, repeatVerdict) {
  if (repeats(fixture)) {
    if (!('message' in written)) return [];
    if (!repeatVerdict || repeatVerdict.score < JUDGE_MIN) {
      const detail = repeatVerdict
        ? `${repeatVerdict.score} (${repeatVerdict.reason})`
        : 'no verdict';
      return [`repeats a recent text: ${detail}`];
    }
    return [];
  }
  if ('skipped' in written) return [`writer skipped: ${written.skipped}`];
  const failures = [];
  const body = written.message.toLowerCase();
  for (const name of fixture.expect.names) {
    if (!body.includes(name)) failures.push(`never names ${name}`);
  }
  for (const url of fixture.expect.urls) {
    if (!written.message.includes(url)) failures.push(`missing ${url}`);
  }
  if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
  return failures;
}

function judgeCeiling(model) {
  return String(model).includes('haiku') ? 4096 : 8192;
}

/**
 * Cache misses only. A subject miss prices the judge too: the live run writes,
 * then grades. The draft lane thinks between tools, so the subject adds no
 * thinking tokens. The judge is Haiku with thinking off.
 */
export async function uncachedWriterCalls(judgeOutputChars) {
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const judgeModel = await readJudgeModel();
  const measured = [];
  const calls = [];
  const shortIds = [];
  let lane = null;
  for (const fixture of PROACTIVE_WRITER_FIXTURES) {
    const prompt = await writerPrompt(fixture, agent, tools);
    lane = prompt.lane;
    const userMessage = prompt.userMessage;
    const key = laneToolCacheKey({
      agent,
      lane,
      tag: evalRunTag(`proactive-writer:${fixture.id}`),
      system: prompt.system,
      userMessage,
      toolName: tools.WRITER_TOOL,
      toolSchema: prompt.toolSchema,
      maxTokens: tools.WRITER_MAX_TOKENS,
    });
    const cached = await cacheGet(key);
    let message = null;
    if (cached) {
      measured.push(JSON.stringify(cached.value).length);
      const written = tools.readWriterText(cached.value, fixture.items, prompt.guard);
      if ('message' in written) message = written.message;
    } else {
      shortIds.push(fixture.id);
    }
    if (repeats(fixture)) {
      if (cached && message === null) continue;
      if (!cached) {
        calls.push({
          model: lane.model,
          promptCache: false,
          prefixId: 'proactive-writer',
          prefix: `${prompt.system}\n${JSON.stringify(prompt.toolSchema)}`,
          user: userMessage,
          thinkingTokens: 0,
          group: 'proactive-writer',
          maxTokens: tools.WRITER_MAX_TOKENS,
          fixtureId: fixture.id,
        });
      }
      if (message !== null || !cached) {
        const judgeUser = JSON.stringify({
          recentTexts: fixture.recentTexts,
          items: fixture.items,
          text: message ?? 'A short text about the items.',
        });
        const judgeKey = cacheKey(
          `proactive-writer-repeat:judge:${fixture.id}`,
          `${judgeModel}\n${REPEAT_JUDGE_SYSTEM}\n${judgeUser}`,
        );
        const judged = await cacheGet(judgeKey);
        if (!(judged && isVerdict(judged.parsed))) {
          calls.push({
            model: judgeModel,
            promptCache: true,
            prefixId: 'proactive-writer-repeat-judge',
            prefix: `${REPEAT_JUDGE_SYSTEM}\n${JSON.stringify(JUDGE_SCHEMA)}`,
            user: judgeUser,
            outputChars: judgeOutputChars,
            thinkingTokens: 0,
            group: 'proactive-writer',
            maxTokens: judgeCeiling(judgeModel),
            fixtureId: fixture.id,
          });
        }
      }
      continue;
    }
    if (cached && message === null) continue;
    const text = message ?? 'A short text about the items.';
    const judgeUser = JSON.stringify({
      context: JSON.parse(userMessage),
      text,
    });
    if (message !== null) {
      const judgeKey = cacheKey(
        `proactive-writer:judge:${fixture.id}`,
        `${judgeModel}\n${JUDGE_SYSTEM}\n${judgeUser}`,
      );
      const judged = await cacheGet(judgeKey);
      if (judged && isVerdict(judged.parsed) && !cached) {
        // subject miss still needs the write; the judge can already be cached
      } else if (judged && isVerdict(judged.parsed)) {
        continue;
      }
    }
    if (!cached) {
      calls.push({
        model: lane.model,
        promptCache: false,
        prefixId: 'proactive-writer',
        prefix: `${prompt.system}\n${JSON.stringify(prompt.toolSchema)}`,
        user: userMessage,
        thinkingTokens: 0,
        group: 'proactive-writer',
        maxTokens: tools.WRITER_MAX_TOKENS,
        fixtureId: fixture.id,
      });
    }
    if (message === null || !(await judgeHit(judgeModel, fixture.id, judgeUser))) {
      calls.push({
        model: judgeModel,
        promptCache: true,
        prefixId: 'proactive-writer-judge',
        prefix: `${JUDGE_SYSTEM}\n${JSON.stringify(JUDGE_SCHEMA)}`,
        user: judgeUser,
        outputChars: judgeOutputChars,
        thinkingTokens: 0,
        group: 'proactive-writer',
        maxTokens: judgeCeiling(judgeModel),
        fixtureId: fixture.id,
      });
    }
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

async function judgeHit(judgeModel, id, judgeUser) {
  const judgeKey = cacheKey(
    `proactive-writer:judge:${id}`,
    `${judgeModel}\n${JUDGE_SYSTEM}\n${judgeUser}`,
  );
  const judged = await cacheGet(judgeKey);
  return Boolean(judged && isVerdict(judged.parsed));
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
  const getClient = () => capSdkClient(rawClient(), { rates: priceRates, tag: 'proactive-writer' });
  const cost = makeCost();
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'proactive-writer',
    cachedOnly,
    getClient,
    cost,
  );
  const repeatJudge = makeJudge(
    judgeModel,
    REPEAT_JUDGE_SYSTEM,
    'proactive-writer-repeat',
    cachedOnly,
    getClient,
    cost,
  );

  console.info(
    `proactive-writer | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} judge=${judgeModel} | fixtures=${PROACTIVE_WRITER_FIXTURES.length}`,
  );
  const misses = [];
  let failed = 0;
  for (const fixture of PROACTIVE_WRITER_FIXTURES) {
    const prompt = await writerPrompt(fixture, agent, tools);
    const call = await cachedLaneToolCall({
      agent,
      lane: prompt.lane,
      tag: evalRunTag(`proactive-writer:${fixture.id}`),
      system: prompt.system,
      userMessage: prompt.userMessage,
      toolName: tools.WRITER_TOOL,
      toolDescription: prompt.guard
        ? 'The one text Hale sends, or null when it would repeat a recent text.'
        : 'The one text Hale sends.',
      toolSchema: prompt.toolSchema,
      maxTokens: tools.WRITER_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const written = tools.readWriterText(call.value, fixture.items, prompt.guard);
    const verdict =
      !repeats(fixture) && 'message' in written
        ? await judge(fixture.id, {
            context: JSON.parse(prompt.userMessage),
            text: written.message,
          })
        : null;
    const repeatVerdict =
      repeats(fixture) && 'message' in written
        ? await repeatJudge(fixture.id, {
            recentTexts: fixture.recentTexts,
            items: fixture.items,
            text: written.message,
          })
        : null;
    const failures = grade(fixture, written, verdict, repeatVerdict);
    if (failures.length > 0) failed += 1;
    console.info(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    if ('message' in written) console.info(`        > ${written.message}`);
    for (const failure of failures) console.info(`        - ${failure}`);
  }
  if (misses.length > 0) {
    console.error(`proactive-writer: ${misses.length} cache miss(es) in --cached-only`);
    for (const miss of misses) console.error(`  ${miss}`);
    process.exit(1);
  }
  const passed = PROACTIVE_WRITER_FIXTURES.length - failed;
  console.info(
    `\n${passed}/${PROACTIVE_WRITER_FIXTURES.length} passed | live API calls: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
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
