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

import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  REPO_ROOT,
  evalRunTag,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { cachedLaneToolCall } from './lib/lane-tool-call.mjs';
import { PROACTIVE_WRITER_FIXTURES } from './proactive-writer-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'proactive-writer.md');
const TOOLS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'proactive', 'tools.ts');

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale, a family planner that lives in',
  "the parent's messages, sends a parent on its own initiative. You are given `context` -",
  'exactly what the writer was given: the `items` to send, each with `what` and `why` and',
  'maybe a `sourceUrl`, and maybe a `note` that the parent asked to hear less - and the',
  '`text`. Score 1-5. Write your argument first, quoting the text, and only then the score.',
  'A 5 is one text that covers every item, adds nothing the items do not say, asks the',
  'parent for at most one thing, and reads like a friend who is also a parent texting:',
  'chill, casual, specific. With a `note`, it is shorter, not colder.',
  'Do not grade word choice, length or punctuation for their own sake; the writer picks',
  'the words.',
  'A 1 or 2 is any of: an item missing; a link, time, price or place no item gives; more',
  'than one ask; a word the parent is told to reply with; a numbered list or a template.',
  'A 3 covers the items but reads like a notification or an assistant offering a service',
  'rather than a friend texting.',
  'Reply with ONLY the score tool.',
].join(' ');

function grade(fixture, written, verdict) {
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

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const getClient = lazyAnthropic();
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

  console.info(
    `proactive-writer | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} judge=${judgeModel} | fixtures=${PROACTIVE_WRITER_FIXTURES.length}`,
  );
  const misses = [];
  let failed = 0;
  for (const fixture of PROACTIVE_WRITER_FIXTURES) {
    const call = await cachedLaneToolCall({
      agent,
      lane,
      tag: evalRunTag(`proactive-writer:${fixture.id}`),
      system: skill.instructions,
      userMessage: tools.writerContext(fixture.items, fixture.cadenceNote),
      toolName: tools.WRITER_TOOL,
      toolDescription: 'The one text Hale sends.',
      toolSchema: tools.WRITER_TOOL_SCHEMA,
      maxTokens: tools.WRITER_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const written = tools.readWriterText(call.value, fixture.items);
    const verdict =
      'message' in written
        ? await judge(fixture.id, {
            context: JSON.parse(tools.writerContext(fixture.items, fixture.cadenceNote)),
            text: written.message,
          })
        : null;
    const failures = grade(fixture, written, verdict);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
