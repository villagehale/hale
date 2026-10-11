// VIL-226 · proactive writer eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/proactive-writer.md, called the way the runtime calls it
// (apps/web/lib/channel/proactive/compose.ts): the `proactive_text` tool forced on the
// skill's lane, then the runtime's own grounding check and link rule (readWriterText).
// The grade is the text a parent would read.
//
//   ANTHROPIC_API_KEY=... node evals/run-proactive-writer-eval.mjs   # live, populates the cache
//   node evals/run-proactive-writer-eval.mjs --cached-only           # CI: replay, zero API calls

import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { REPO_ROOT, evalRunTag, lazyAnthropic, makeCost, totalUsd } from './lib/harness.mjs';
import { cachedLaneToolCall } from './lib/lane-tool-call.mjs';
import { PROACTIVE_WRITER_FIXTURES } from './proactive-writer-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'proactive-writer.md');
const TOOLS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'proactive', 'tools.ts');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

/** Filler the skill forbids by name. */
const FILLER = ['just checking in', 'hope this helps'];

function grade(fixture, written, isPrintableGsm7Basic) {
  if ('skipped' in written) return [`writer skipped: ${written.skipped}`];
  const failures = [];
  const body = written.message.toLowerCase();
  for (const name of fixture.expect.names) {
    if (!body.includes(name)) failures.push(`never names ${name}`);
  }
  for (const url of fixture.expect.urls) {
    if (!written.message.includes(url)) failures.push(`missing ${url}`);
  }
  for (const phrase of FILLER) {
    if (body.includes(phrase)) failures.push(`filler "${phrase}"`);
  }
  if ((written.message.match(/\?/g) ?? []).length > 1) failures.push('more than one question');
  if (!isPrintableGsm7Basic(written.message)) failures.push('not plain GSM-7 punctuation');
  return failures;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const tools = await tsImport(TOOLS_SRC, import.meta.url);
  const { isPrintableGsm7Basic } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  console.info(
    `proactive-writer | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} | fixtures=${PROACTIVE_WRITER_FIXTURES.length}`,
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
    const failures = grade(fixture, written, isPrintableGsm7Basic);
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
