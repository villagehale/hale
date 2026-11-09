// The new-member group welcome · composer eval (VIL-438, hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/group-onboarding-voice.md) over the
// REAL input: `groupOnboardingLineInput` is imported from group-onboarding-line-input.ts,
// not replicated. The tool shape mirrors the `questions: 1` branch of productionComposer in
// group-onboarding-voice.ts (`send_group_line`, before + question), and the only code gate is
// the member-welcome branch of its `lineUsable` (non-empty, no URL). Whether the welcome
// carries the facts, in the right language and register, is the judge's call.
//
//   node evals/run-group-welcome-voice-eval.mjs --max-usd 0.40   # live, then caches
//   node evals/run-group-welcome-voice-eval.mjs --broken         # calibration: must FAIL
//   node evals/run-group-welcome-voice-eval.mjs --cached-only    # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { GROUP_WELCOME_VOICE_FIXTURES } from './group-welcome-voice-fixtures.mjs';
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
import { judgePrompt } from './lib/judge-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-onboarding-voice.md');
const INPUT_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-onboarding-line-input.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** maxTokens for the full prompt in productionComposer. */
const MAX_TOKENS = 400;

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { before: { type: 'string' }, question: { type: 'string' } },
  required: ['before', 'question'],
};

const JUDGE_SYSTEM = judgePrompt('group-welcome-voice');

const BROKEN = 'Welcome!! We can see all your calendars and emails 🎉 Reply YES at www.example.com';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('group-welcome-voice');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const { groupOnboardingLineInput } = await importTs(INPUT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'group-welcome-voice',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `group-welcome-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of GROUP_WELCOME_VOICE_FIXTURES) {
    const input = groupOnboardingLineInput(fixture.request, fixture.language);
    const userMessage = JSON.stringify({ ...input, retry: false });
    let body;
    if (broken) {
      body = BROKEN;
    } else {
      const value = (
        await cachedToolCall({
          tag: `group-welcome-voice:${fixture.id}`,
          model,
          lane,
          system: skill.instructions,
          userMessage,
          toolName: 'send_group_line',
          toolSchema: TOOL_SCHEMA,
          toolDescription: 'The one message Hale sends.',
          maxTokens: MAX_TOKENS,
          cachedOnly,
          getClient,
          cost,
        })
      ).value;
      body = [value.before, value.question].filter(Boolean).join(' ').trim();
    }
    const failures = [];
    if (body.length === 0 || /https?:\/\//i.test(body)) failures.push('unusable');
    const verdict = await judge(fixture.id, {
      input: userMessage,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(20)} "${r.body}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('group-welcome-voice eval harness error:', err);
  process.exit(2);
});
