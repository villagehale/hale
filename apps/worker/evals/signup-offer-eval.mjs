// Signup offer writer estimate (hard rule #8: no LLM mocking, and this file
// does not call the API).
//
// SUBJECT: packages/agent/skills/signup-offer.md, called the way the
// runtime calls it (apps/web/lib/signup/offer-writer.ts).
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it
// up. It is not in package.json and not in ci.yml. There is no committed cache.
//
//   node evals/signup-offer-eval.mjs --estimate
//
// --estimate prices the writer over the fixtures at max_tokens and exits 0.
// It does not call the API and it does not write a cache file.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { PRICE, REPO_ROOT } from './lib/harness.mjs';
import { SIGNUP_OFFER_FIXTURES } from './signup-offer-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-offer.md');
const WRITER_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'signup', 'offer-writer.ts');

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

function suiteUsd({ lane, skill, writer }) {
  let usd = 0;
  for (const fixture of SIGNUP_OFFER_FIXTURES) {
    const userMessage = writer.signupOfferUserMessage(fixture.facts);
    const input =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: writer.SIGNUP_OFFER_TOOL,
        description: 'Write the one text that offers this registration.',
        input_schema: writer.SIGNUP_OFFER_TOOL_SCHEMA,
      });
    usd += priced(lane.model, input, writer.SIGNUP_OFFER_MAX_TOKENS);
  }
  return usd;
}

async function main() {
  if (!process.argv.includes('--estimate')) {
    console.error('signup-offer: pass --estimate. This runner does not call the API.');
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const writer = await importTs(WRITER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const usd = suiteUsd({ lane, skill, writer });
  console.info(
    `signup-offer: one estimate to record ${SIGNUP_OFFER_FIXTURES.length} fixtures (writer only), priced at max_tokens on ${lane.model}. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
