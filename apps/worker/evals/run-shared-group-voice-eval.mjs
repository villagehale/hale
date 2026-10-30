// Shared-group voice · composer eval (VIL-456). Judges score meaning 1-5.
// Paid recording is not approved on this PR. --estimate prices one live run.
//
//   node evals/run-shared-group-voice-eval.mjs --estimate
//   node evals/run-shared-group-voice-eval.mjs --cached-only
//   node evals/run-shared-group-voice-eval.mjs --broken

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { SHARED_GROUP_VOICE_FIXTURES } from './shared-group-voice-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'shared-group-voice.md');
const INPUT_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'shared-group-line-input.ts');
const VOICE_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'shared-group-voice.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const MAX_TOKENS = 400;
const HAIKU_IN = 1;
const HAIKU_OUT = 5;
const OPUS_IN = 15;
const OPUS_OUT = 75;

function tokens(chars) {
  return Math.ceil(chars / 4);
}

function estimateWorstCase() {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  let expected = 0;
  let worst = 0;
  for (const fixture of SHARED_GROUP_VOICE_FIXTURES) {
    const user = JSON.stringify(fixture);
    const inputTokens = tokens(skill.length + user.length);
    expected += (inputTokens / 1e6) * HAIKU_IN + (120 / 1e6) * HAIKU_OUT;
    worst += (inputTokens / 1e6) * HAIKU_IN + (MAX_TOKENS / 1e6) * HAIKU_OUT;
    const judgeIn = tokens(800 + user.length + 260);
    expected += (judgeIn / 1e6) * OPUS_IN + (80 / 1e6) * OPUS_OUT;
    worst += (judgeIn / 1e6) * OPUS_IN + (200 / 1e6) * OPUS_OUT;
  }
  return { fixtures: SHARED_GROUP_VOICE_FIXTURES.length, expected, worst };
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE message Hale posts in a multi-family group chat.',
  'Score 1-5 on MEANING, not wording. A 5 gets the facts across in its own words.',
  'LOW if it invents availability, quotes a private calendar or inbox, tells anyone to',
  'reply with a keyword, uses a fixed template, or leaks a name that was not in the input.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN = 'TODO-Design: reply YES at https://example.com — Zephyrina is free Saturday!!';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const estimateOnly = process.argv.includes('--estimate');
  if (estimateOnly && cachedOnly) {
    console.error('shared-group-voice: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  const quote = estimateWorstCase();
  if (estimateOnly) {
    console.info(`shared-group-voice estimate | fixtures=${quote.fixtures} | no API calls`);
    console.info(`expected: $${quote.expected.toFixed(4)} USD`);
    console.info(`worst-case one live run: $${quote.worst.toFixed(4)} USD`);
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('shared-group-voice');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { sharedGroupLineInput } = await importTs(INPUT_SRC);
  const { sharedLineUsable } = await importTs(VOICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'shared-group-voice',
    cachedOnly,
    getClient,
    cost,
    {
      maxTokens: 200,
      toolSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { score: { type: 'number' }, reason: { type: 'string' } },
        required: ['score', 'reason'],
      },
      keepTruncatedScore: true,
    },
  );

  console.log(
    `shared-group-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | model=${model} judge=${judgeModel}`,
  );
  let failed = 0;
  for (const fixture of SHARED_GROUP_VOICE_FIXTURES) {
    const input = sharedGroupLineInput(fixture.request, fixture.language, {
      parentWords: fixture.parentWords ?? null,
      threadSaid: fixture.threadSaid ?? [],
    });
    const line = broken
      ? BROKEN
      : (
          await cachedToolCall({
            tag: `shared-group-voice:${fixture.id}`,
            model,
            lane,
            system: skill.instructions,
            userMessage: JSON.stringify(input),
            toolName: 'send_shared_group_line',
            toolSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                send: { type: 'boolean' },
                line: { type: 'string' },
                before: { type: 'string' },
                question: { type: 'string' },
                why: { type: 'string' },
              },
              required: ['send'],
            },
            toolDescription: 'The one message Hale sends, or a decision to stay quiet.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    const text =
      typeof line === 'string'
        ? line
        : [line.before, line.question, line.line].filter(Boolean).join(' ');
    const usable = broken ? false : sharedLineUsable(text, input);
    const verdict = broken
      ? { score: 1, reason: 'broken stand-in' }
      : await judge(fixture.id, { input, line: text, watchFor: fixture.watchFor });
    const pass = usable && verdict && verdict.score >= JUDGE_MIN;
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(24)} usable=${usable} judge=${verdict?.score ?? 'missing'}`,
    );
    if (!pass) failed += 1;
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (!broken) process.exit(failed === 0 ? 0 : 1);
  process.exit(failed > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('shared-group-voice eval harness error:', err);
  process.exit(2);
});
