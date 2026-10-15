// Mid-signup screen estimate (hard rule #8: no LLM mocking, and this file
// does not call the API).
//
// SUBJECT: packages/agent/skills/signup-step-reply.md, called the way the
// runtime calls it (apps/web/lib/channel/intake/signup-step.ts).
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it
// up. It is not in package.json and not in ci.yml. There is no committed cache.
//
//   node evals/signup-step-reply-eval.mjs --estimate
//
// --estimate prices the screen over the fixtures at max_tokens and exits 0.
// It does not call the API and it does not write a cache file.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { PRICE, REPO_ROOT } from './lib/harness.mjs';
import { SIGNUP_STEP_REPLY_FIXTURES } from './signup-step-reply-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-step-reply.md');
const REPLY_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'intake', 'signup-step.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

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

function suiteUsd({ lane, skill, reply }) {
  let usd = 0;
  for (const fixture of SIGNUP_STEP_REPLY_FIXTURES) {
    const userMessage = reply.signupStepReplyUserMessage({
      step: fixture.step,
      text: fixture.text,
    });
    const input =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: reply.SIGNUP_STEP_REPLY_TOOL,
        description: 'Decide whether this message answers the open signup step.',
        input_schema: reply.SIGNUP_STEP_REPLY_TOOL_SCHEMA,
      });
    usd += priced(lane.model, input, reply.SIGNUP_STEP_REPLY_MAX_TOKENS);
  }
  return usd;
}

async function main() {
  if (!process.argv.includes('--estimate')) {
    console.error('signup-step-reply: pass --estimate. This runner does not call the API.');
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const reply = await importTs(REPLY_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const usd = suiteUsd({ lane, skill, reply });
  console.info(
    `signup-step-reply: one estimate to record ${SIGNUP_STEP_REPLY_FIXTURES.length} fixtures (screen only), priced at max_tokens on ${lane.model}. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
