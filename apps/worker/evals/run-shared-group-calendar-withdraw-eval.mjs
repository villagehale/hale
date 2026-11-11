// VIL-643 — calendar-only withdrawal on the common-time group reader.
//
// Subject: packages/agent/skills/shared-group-reading-common-time.md through the
// real request shape. Gate: intent label. Record once, then --cached-only.
// Not wired into CI until a recording exists (no live/paid evals on this PR).
//
//   node evals/run-shared-group-calendar-withdraw-eval.mjs --estimate
//   node evals/run-shared-group-calendar-withdraw-eval.mjs --cached-only

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { SHARED_GROUP_CALENDAR_WITHDRAW_FIXTURES } from './shared-group-calendar-withdraw-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(
  REPO_ROOT,
  'packages',
  'agent',
  'skills',
  'shared-group-reading-common-time.md',
);
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'shared-group-reading.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const MAX_TOKENS = 400;
const SONNET_IN = 3;
const SONNET_OUT = 15;

function tokens(chars) {
  return Math.ceil(chars / 4);
}

function estimateWorstCase() {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  let worst = 0;
  let expected = 0;
  for (const fixture of SHARED_GROUP_CALENDAR_WITHDRAW_FIXTURES) {
    const input = JSON.stringify(fixture.input);
    const inputTokens = tokens(skill.length + input.length);
    expected += (inputTokens / 1e6) * SONNET_IN + (80 / 1e6) * SONNET_OUT;
    const hold = (inputTokens / 1e6) * SONNET_IN + (MAX_TOKENS / 1e6) * SONNET_OUT;
    worst += hold;
  }
  return { fixtures: SHARED_GROUP_CALENDAR_WITHDRAW_FIXTURES.length, expected, worst };
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const estimateOnly = process.argv.includes('--estimate');
  if (estimateOnly && cachedOnly) {
    console.error('shared-group-calendar-withdraw: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  const quote = estimateWorstCase();
  if (estimateOnly) {
    console.info(
      `shared-group-calendar-withdraw estimate | fixtures=${quote.fixtures} | no API calls`,
    );
    console.info(`expected: $${quote.expected.toFixed(4)} USD`);
    console.info(`worst-case one live run: $${quote.worst.toFixed(4)} USD`);
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('shared-group-calendar-withdraw');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const {
    parseSharedGroupReading,
    sharedGroupReadingCommonTimeJsonSchema,
    sharedGroupUserMessage,
  } = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);

  console.info(
    `shared-group-calendar-withdraw eval | mode=real${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  const results = [];
  for (const fixture of SHARED_GROUP_CALENDAR_WITHDRAW_FIXTURES) {
    const reading = parseSharedGroupReading(
      (
        await cachedToolCall({
          tag: `shared-group-calendar-withdraw:${fixture.id}`,
          model,
          lane,
          system: skill.instructions,
          userMessage: sharedGroupUserMessage(fixture.input),
          toolName: 'record_shared_group_reading',
          toolSchema: sharedGroupReadingCommonTimeJsonSchema,
          toolDescription: 'What this person meant in the shared group.',
          maxTokens: MAX_TOKENS,
          cachedOnly,
          getClient,
          cost,
        })
      ).value,
    );
    results.push({
      fixture,
      intent: reading.intent,
      pass: fixture.accept.includes(reading.intent),
    });
  }
  for (const r of results) {
    console.info(
      `${r.pass ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(36)} intent=${r.intent} accept=${r.fixture.accept.join('|')}`,
    );
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => {
  console.error(
    'shared-group-calendar-withdraw eval harness error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
