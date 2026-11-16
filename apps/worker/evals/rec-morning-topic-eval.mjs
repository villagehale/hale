// rec-morning-topic eval (VIL-545 leftover).
//
// The model picks which rec-morning facts answer a parent's text, or none. The word
// test is not consulted. Only a catalog id lets the lane speak, so the output has an
// exactly right answer: scored through the same accept production uses, with no judge.
//
// One forced call per fixture, max 256 tokens, Haiku (`task: screen`). The request
// shape, schema and accept are imported from apps/web/lib/channel/rec-morning/topic.ts,
// and the catalog is production recMorningCatalog at a fixed clock.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up.
// Do not record from CI. This runner has no --live.
//
// Usage (from apps/worker):
//   node evals/rec-morning-topic-eval.mjs --estimate
//   node evals/rec-morning-topic-eval.mjs --cached-only

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import {
  REC_MORNING_TOPIC_FIXTURES,
  REC_MORNING_TOPIC_NOW,
  REC_MORNING_TOPIC_WHERE,
} from './rec-morning-topic-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'rec-morning-topic.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const PICKER_SRC = join(WEB_ROOT, 'lib', 'channel', 'rec-morning', 'topic.ts');
const COPY_SRC = join(WEB_ROOT, 'lib', 'channel', 'rec-morning', 'copy.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function tokens(chars) {
  return Math.ceil(chars / 3);
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const estimateOnly = process.argv.includes('--estimate');
  if (estimateOnly && cachedOnly) {
    console.error('rec-morning-topic: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  if (!estimateOnly && !cachedOnly) {
    console.error(
      'rec-morning-topic: pass --estimate or --cached-only. This runner has no --live.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const picker = await importTs(PICKER_SRC);
  const copy = await importTs(COPY_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = REC_MORNING_TOPIC_FIXTURES;
  const catalog = copy.recMorningCatalog(new Date(REC_MORNING_TOPIC_NOW), REC_MORNING_TOPIC_WHERE);
  if (catalog.length === 0) throw new Error('rec-morning-topic: empty catalog at the eval clock');
  const known = catalog.map((entry) => entry.topic);

  if (estimateOnly) {
    const rates = PRICE[lane.model];
    if (!rates) throw new Error(`no price for ${lane.model}`);
    let expected = 0;
    let worst = 0;
    for (const fixture of fixtures) {
      const user = picker.recMorningTopicUserMessage({
        text: fixture.text,
        language: 'en',
        homeCity: REC_MORNING_TOPIC_WHERE.municipality,
        topics: catalog,
      });
      const inputTokens = tokens(skill.instructions.length + user.length);
      expected += (inputTokens / 1e6) * rates.input + (80 / 1e6) * rates.output;
      worst +=
        (inputTokens / 1e6) * rates.input +
        (picker.REC_MORNING_TOPIC_MAX_TOKENS / 1e6) * rates.output;
    }
    console.info(
      `rec-morning-topic estimate | fixtures=${fixtures.length} model=${lane.model} | no API calls`,
    );
    console.info(`expected: $${expected.toFixed(4)} USD`);
    console.info(`worst-case one live run: $${worst.toFixed(4)} USD`);
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('rec-morning-topic');
  const cost = makeCost();
  const failures = [];
  for (const fixture of fixtures) {
    const call = await cachedToolCall({
      tag: `rec-morning-topic:${picker.REC_MORNING_TOPIC_MAX_TOKENS}:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: picker.recMorningTopicUserMessage({
        text: fixture.text,
        language: 'en',
        homeCity: REC_MORNING_TOPIC_WHERE.municipality,
        topics: catalog,
      }),
      toolName: 'rec_morning_topic',
      toolDescription: 'Return the id of the facts that answer what the parent is asking, or none.',
      toolSchema: picker.REC_MORNING_TOPIC_TOOL_SCHEMA,
      maxTokens: picker.REC_MORNING_TOPIC_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const picked = picker.acceptRecMorningTopic(call.value, known);
    const ok = picked === fixture.expect;
    if (!ok) failures.push(fixture.id);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.path}  ${fixture.id}  ${picked} (wanted ${fixture.expect})`,
    );
    if (!ok) console.info(`      reason: ${call.value?.reason ?? ''}`);
  }
  console.info(
    `rec-morning-topic | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
