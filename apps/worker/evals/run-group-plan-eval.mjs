// Plan together · reader + writer eval (VIL-441, hard rule #8: no LLM mocking).
//
// Reader: REAL `group-plan-read` skill through REAL `groupPlanUserMessage`.
// Writer: REAL `spoken-line` skill. A judge scores meaning 1-5.
//
//   node evals/run-group-plan-eval.mjs --max-usd 0.80   # live, then caches
//   node evals/run-group-plan-eval.mjs --broken         # calibration: must FAIL
//   node evals/run-group-plan-eval.mjs --cached-only    # CI: replay only
//   HALE_ESTIMATE=1 node evals/run-group-plan-eval.mjs  # dry worst-case cost

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_PLAN_READ_FIXTURES, GROUP_PLAN_VOICE_FIXTURES } from './group-plan-fixtures.mjs';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const READ_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-plan-read.md');
const WRITE_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'spoken-line.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-plan-reader.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const READ_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['plan_ask', 'yes', 'no', 'maybe', 'unclear', 'chatter'],
    },
    optionId: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['intent', 'optionId', 'subject', 'confidence'],
};

const WRITE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE message Hale posted in a family group chat',
  'while helping the group pick something to do. Score meaning 1-5.',
  'A 5 is short, plain, in the language of `language`, carries the options or names',
  'from facts, invents no time or availability, names no poll or button, and does not',
  'tell people which word to reply with.',
  'A 1 invents a time, leaks a private calendar title, uses a template keyword,',
  'or is the wrong language.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN_REPLY =
  'POLL TIME!! Reply YES or NO. Priya is free Saturday after her lawyer consult.';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('group-plan');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { GROUP_PLAN_INTENTS, groupPlanUserMessage } = await importTs(READER_SRC);
  const readSkill = await agent.loadSkill(READ_SKILL);
  const writeSkill = await agent.loadSkill(WRITE_SKILL);
  const readModel = agent.pickModel(readSkill.meta.task);
  const writeModel = agent.pickModel(writeSkill.meta.task);
  const readLane = agent.pickLane(readSkill.meta.task);
  const writeLane = agent.pickLane(writeSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'group-plan', cachedOnly, getClient, cost);

  console.log(
    `group-plan eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | read=${readModel} write=${writeModel}`,
  );

  const results = [];
  for (const fixture of GROUP_PLAN_READ_FIXTURES) {
    const intent = broken
      ? 'chatter'
      : (
          await cachedToolCall({
            tag: `group-plan-read:${fixture.id}`,
            model: readModel,
            lane: readLane,
            system: readSkill.instructions,
            userMessage: groupPlanUserMessage(fixture.input),
            toolName: 'group_plan',
            toolSchema: READ_SCHEMA,
            toolDescription: 'Return whether this group message is a plan ask or a yes/no/maybe.',
            maxTokens: 200,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.intent;
    results.push({
      kind: 'read',
      fixture,
      intent,
      pass: fixture.accept.includes(intent),
    });
    if (!GROUP_PLAN_INTENTS.includes(intent) && !broken) {
      throw new Error(`group-plan-read ${fixture.id}: unknown intent ${intent}`);
    }
  }

  for (const fixture of GROUP_PLAN_VOICE_FIXTURES) {
    const text = broken
      ? BROKEN_REPLY
      : (
          await cachedToolCall({
            tag: `group-plan-voice:${fixture.id}`,
            model: writeModel,
            lane: writeLane,
            system: writeSkill.instructions,
            userMessage: JSON.stringify({
              purpose: fixture.purpose,
              language: fixture.language,
              facts: fixture.facts,
              verbatim: [],
            }),
            toolName: 'spoken_line',
            toolSchema: WRITE_SCHEMA,
            toolDescription: 'Write the one text Hale will send.',
            maxTokens: 400,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.text;
    const verdict = await judge(fixture.id, JSON.stringify({ fixture, text }));
    results.push({
      kind: 'voice',
      fixture,
      text,
      score: verdict.score,
      pass: verdict.score >= JUDGE_MIN,
    });
  }

  for (const r of results) {
    if (r.kind === 'read') {
      console.log(
        `${r.pass ? 'PASS' : 'FAIL'}  read ${r.fixture.id.padEnd(22)} intent=${r.intent} accept=${r.fixture.accept.join('|')}`,
      );
    } else {
      console.log(
        `${r.pass ? 'PASS' : 'FAIL'}  voice ${r.fixture.id.padEnd(22)} score=${r.score}  "${(r.text ?? '').slice(0, 80)}"`,
      );
    }
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
  console.error('group-plan eval harness error:', err);
  process.exit(2);
});
