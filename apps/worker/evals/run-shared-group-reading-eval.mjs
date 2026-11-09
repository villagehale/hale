// Shared-group inference · classifier eval (VIL-456, hard rule #8: no LLM mocking).
//
// The subject is the REAL skill through the REAL request shape. The gate is the
// intent label: a wrong reading seats the wrong family or answers banter.
// Judges score meaning. Paid recording is not approved on this PR.
//
//   node evals/run-shared-group-reading-eval.mjs --estimate     # no API
//   node evals/run-shared-group-reading-eval.mjs --cached-only  # CI once recorded
//   node evals/run-shared-group-reading-eval.mjs --broken       # calibration

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
import { SHARED_GROUP_READING_FIXTURES } from './shared-group-reading-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'shared-group-reading.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'shared-group-reading.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const MAX_TOKENS = 200;
const SONNET_IN = 3;
const SONNET_OUT = 15;

function tokens(chars) {
  return Math.ceil(chars / 4);
}

function estimateWorstCase() {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  let worst = 0;
  let expected = 0;
  for (const fixture of SHARED_GROUP_READING_FIXTURES) {
    const input = JSON.stringify(fixture.input);
    const inputTokens = tokens(skill.length + input.length);
    expected += (inputTokens / 1e6) * SONNET_IN + (80 / 1e6) * SONNET_OUT;
    const hold = (inputTokens / 1e6) * SONNET_IN + (MAX_TOKENS / 1e6) * SONNET_OUT;
    worst += hold;
  }
  return { fixtures: SHARED_GROUP_READING_FIXTURES.length, expected, worst };
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const estimateOnly = process.argv.includes('--estimate');
  if (estimateOnly && cachedOnly) {
    console.error('shared-group-reading: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  const quote = estimateWorstCase();
  if (estimateOnly) {
    console.info(`shared-group-reading estimate | fixtures=${quote.fixtures} | no API calls`);
    console.info(`expected: $${quote.expected.toFixed(4)} USD`);
    console.info(`worst-case one live run: $${quote.worst.toFixed(4)} USD`);
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('shared-group-reading');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { SHARED_GROUP_INTENTS, sharedGroupUserMessage } = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const toolSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: [...SHARED_GROUP_INTENTS] },
      role: { type: 'string' },
      familyLabel: { type: ['string', 'null'] },
      kidName: { type: ['string', 'null'] },
      confidence: { type: 'string', enum: ['high', 'low'] },
    },
    required: ['intent', 'role', 'familyLabel', 'kidName', 'confidence'],
  };

  console.log(
    `shared-group-reading eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model}`,
  );
  const results = [];
  for (const fixture of SHARED_GROUP_READING_FIXTURES) {
    const intent = broken
      ? 'question'
      : (
          await cachedToolCall({
            tag: `shared-group-reading:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: sharedGroupUserMessage(fixture.input),
            toolName: 'record_shared_group_reading',
            toolSchema,
            toolDescription: 'What this person meant in the shared group.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.intent;
    results.push({ fixture, intent, pass: fixture.accept.includes(intent) });
  }
  for (const r of results) {
    console.log(
      `${r.pass ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} intent=${r.intent} accept=${r.fixture.accept.join('|')}`,
    );
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.pass);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('shared-group-reading eval harness error:', err);
  process.exit(2);
});
