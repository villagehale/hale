// VIL-481 · Apple Pay App Clip eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/app-clip-pay.md, called the way the runtime calls
// it. A judge scores tone, language, and that no price or billing period is claimed.
// This file is not named run-*.mjs, so the Monday sweep does not pick it up.
// Recording waits for the batch. This file prices the run and does not call the API.
//
//   node evals/app-clip-pay-eval.mjs --estimate
//   node evals/app-clip-pay-eval.mjs --dry

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { APP_CLIP_PAY_FIXTURES } from './app-clip-pay-fixtures.mjs';
import { JUDGE_SCHEMA, PRICE, REPO_ROOT, readJudgeModel } from './lib/harness.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'app-clip-pay.md');
const PAY_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'app-clip-pay.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_MAX_TOKENS = 4096;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE decision about whether Hale offers Apple Pay',
  'in a 1:1 thread. You are given `input` (what the parent sent, the household, and',
  'whether they already said no), `decision` (offer, tier, description, line), and',
  '`situation`. Score 1-5.',
  'FACTS: offer is true only when the parent asked to pay for Plus or Family and is',
  'not already on it. tier is the plan they named, or the one the household makes',
  'obvious. If they did not name one and the household does not decide it, offer is',
  'false and tier is null. Do not accept a silent default to Plus. A prior no means',
  'offer is false.',
  'LANGUAGE: when offer is true, description is in the language the parent wrote.',
  'TONE: a friend texting. Not salesy. No urgency, discount, or unlock. One ask.',
  'MONEY: no price, no currency, no trial, no billing period, in description or line.',
  'A 1 or 2 is any of: offering when they did not ask; offering again after a no;',
  'guessing Plus; the wrong plan; a price or a billing period; a pitch; the wrong',
  'language. A 3 is the right offer with a slightly stiff line. A 5 fits the situation.',
  'Reply with ONLY the score tool.',
].join(' ');

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x024f) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

function worstCaseUsd({ lane, skill, pay, judgeModel }) {
  let usd = 0;
  for (const fixture of APP_CLIP_PAY_FIXTURES) {
    const userMessage = pay.appClipPayUserMessage(fixture.input);
    const writerInput =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: pay.APP_CLIP_PAY_TOOL,
        input_schema: pay.APP_CLIP_PAY_TOOL_SCHEMA,
      });
    usd += priced(lane.model, writerInput, pay.APP_CLIP_PAY_MAX_TOKENS);
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens({
        input: fixture.input,
        decision: { offer: false, tier: null, description: null, line: null },
        situation: fixture.situation,
      }) +
      estimateTokens(JUDGE_SCHEMA);
    usd += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
  }
  return usd;
}

function priceLine(usd, lane, judgeModel) {
  return `app-clip-pay: estimate for ${APP_CLIP_PAY_FIXTURES.length} fixtures (writer ${lane.model} + judge ${judgeModel}) at max_tokens, $${usd.toFixed(4)} USD. live API calls: 0. nothing written.`;
}

async function main() {
  const estimate = process.argv.includes('--estimate');
  const dry = process.argv.includes('--dry');
  if (estimate === dry) {
    console.error(
      'app-clip-pay: pass exactly one of --estimate or --dry. Recording waits for the batch. This file does not call the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const pay = await importTs(PAY_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = worstCaseUsd({ lane, skill, pay, judgeModel });
  console.info(priceLine(usd, lane, judgeModel));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('app-clip-pay eval harness error:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
