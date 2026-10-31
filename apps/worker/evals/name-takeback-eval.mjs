// Name take-back estimate (hard rule #8: no LLM mocking, and this file
// does not call the API).
//
// SUBJECT: packages/agent/skills/onboarding-friend.md, called the way
// readModelParentName calls speakFriend on the open name ask. Five messages
// (undo, Undo, nvm, laisse tomber, 算了) must come back with parentName empty.
//
// This file is not named run-*.mjs, so the Monday sweep does not pick it up.
// It is not in ci.yml. There is no committed cache. Recording waits on Sloane
// (asked cap $3). Do not pass a live flag.
//
//   node evals/name-takeback-eval.mjs --estimate
//
// --estimate prices one onboarding-friend call per fixture at max_tokens and
// exits 0. It does not call the API and it does not write a cache file.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { NAME_TAKEBACK_FIXTURES, parentNameLeftEmpty } from './name-takeback-fixtures.mjs';
import { PRICE, REPO_ROOT } from './lib/harness.mjs';

const SPEND_ASK_USD = 3;
const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'onboarding-friend.md');
const VOICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'intake', 'friend-voice.ts');

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

function suiteUsd({ lane, skill, voice }) {
  let usd = 0;
  for (const fixture of NAME_TAKEBACK_FIXTURES) {
    const userMessage = JSON.stringify(voice.friendVoiceContext(voice.nameAskVoiceInput(fixture.parentWords)));
    const input =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: voice.ONBOARDING_REPLY_TOOL,
        description: voice.ONBOARDING_REPLY_TOOL_DESCRIPTION,
        input_schema: voice.onboardingReplyToolSchema(),
      });
    usd += priced(lane.model, input, voice.ONBOARDING_REPLY_MAX_TOKENS);
  }
  return usd;
}

async function main() {
  if (!process.argv.includes('--estimate')) {
    console.error(
      'name-takeback: pass --estimate. Recording waits on Sloane (asked cap $3). This runner does not call the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const voice = await importTs(VOICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const usd = suiteUsd({ lane, skill, voice });
  if (usd > SPEND_ASK_USD) {
    console.error(
      `name-takeback: estimate $${usd.toFixed(4)} is over the $${SPEND_ASK_USD} ask. live API calls: 0.`,
    );
    process.exit(1);
  }
  for (const fixture of NAME_TAKEBACK_FIXTURES) {
    if (!parentNameLeftEmpty(null)) {
      throw new Error(`${fixture.id}: empty parentName must count as left empty`);
    }
  }
  console.info(
    `name-takeback: estimate to record ${NAME_TAKEBACK_FIXTURES.length} fixtures on ${lane.model}, priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD. Sloane spend OK still required before any record (cap $${SPEND_ASK_USD}).`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
