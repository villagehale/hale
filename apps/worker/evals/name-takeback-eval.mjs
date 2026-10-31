// Name take-back during the open name ask (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/onboarding-friend.md, called the way
// readModelParentName calls speakFriend. undo, Undo, nvm, laisse tomber, and
// 算了 come back with parentName empty. "Dana" comes back as Dana. A question
// comes back with parentName empty and nameDeclined false. The strings are
// the cases. Nothing here decides intent from a word list.
//
// The group-onboarding flag is pinned on so the tool schema matches production
// name capture. CI replays that same request.
//
//   node evals/name-takeback-eval.mjs --estimate
//   HALE_SPEND_LEDGER=... node --env-file=... evals/name-takeback-eval.mjs --live --max-usd 5
//   node evals/name-takeback-eval.mjs --cached-only
//
// --estimate prices one call per fixture at max_tokens and writes nothing.
// --live records under the approved $5 ceiling. --cached-only replays.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { readCapUsd, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import {
  PRICE,
  REPO_ROOT,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { NAME_TAKEBACK_FIXTURES, nameTakebackMatches } from './name-takeback-fixtures.mjs';

const HARD_CAP_USD = 5;
const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'onboarding-friend.md');
const VOICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'intake', 'friend-voice.ts');

// Production name capture sends the v2 tool (coparentGroupMode included).
process.env.LINQ_GROUP_ONBOARDING_V2_ENABLED = 'true';

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
    const userMessage = JSON.stringify(
      voice.friendVoiceContext(voice.nameAskVoiceInput(fixture.parentWords)),
    );
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

async function loadSubject() {
  const agent = await importTs(AGENT_SRC);
  const voice = await importTs(VOICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  return { agent, voice, skill, lane };
}

async function estimate() {
  const { skill, voice, lane } = await loadSubject();
  const usd = suiteUsd({ lane, skill, voice });
  if (usd > HARD_CAP_USD) {
    console.error(
      `name-takeback: estimate $${usd.toFixed(4)} is over the $${HARD_CAP_USD} cap. live API calls: 0.`,
    );
    process.exit(1);
  }
  for (const fixture of NAME_TAKEBACK_FIXTURES) {
    const empty = nameTakebackMatches(fixture, { parentName: null, nameDeclined: false });
    if (fixture.expect.parentName === '' && !empty) {
      throw new Error(`${fixture.id}: empty parentName must count as left empty`);
    }
    if (fixture.expect.parentName !== '' && empty) {
      throw new Error(`${fixture.id}: a name must not count as left empty`);
    }
    if (
      fixture.expect.nameDeclined === false &&
      nameTakebackMatches(fixture, { parentName: null, nameDeclined: true })
    ) {
      throw new Error(`${fixture.id}: a decline must not pass a non-take-back`);
    }
  }
  console.info(
    `name-takeback: estimate to record ${NAME_TAKEBACK_FIXTURES.length} fixtures on ${lane.model}, priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD. Approved cap $${HARD_CAP_USD}.`,
  );
}

async function record() {
  assertRunFlags(['--env-file', '--max-usd']);
  const live = process.argv.includes('--live');
  if (live) {
    const cap = readCapUsd();
    if (cap === null || cap > HARD_CAP_USD) {
      console.error(
        `name-takeback: --live needs --max-usd at most ${HARD_CAP_USD} (approved ceiling). nothing run.`,
      );
      process.exit(2);
    }
    if (!process.env.HALE_SPEND_LEDGER) {
      console.error('name-takeback: set HALE_SPEND_LEDGER. nothing run.');
      process.exit(2);
    }
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('name-takeback');
  const cost = makeCost();
  const cachedOnly = process.argv.includes('--cached-only');
  const { skill, voice, lane } = await loadSubject();

  let failed = 0;
  for (const fixture of NAME_TAKEBACK_FIXTURES) {
    const userMessage = JSON.stringify(
      voice.friendVoiceContext(voice.nameAskVoiceInput(fixture.parentWords)),
    );
    const result = await cachedToolCall({
      tag: `name-takeback:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage,
      toolName: voice.ONBOARDING_REPLY_TOOL,
      toolDescription: voice.ONBOARDING_REPLY_TOOL_DESCRIPTION,
      toolSchema: voice.onboardingReplyToolSchema(),
      maxTokens: voice.ONBOARDING_REPLY_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (result.dry) {
      console.info(`DRY   ${fixture.id}`);
      continue;
    }
    const parentName = result.value?.parentName ?? null;
    const ok = nameTakebackMatches(fixture, result.value);
    if (!ok) failed += 1;
    const declined = JSON.stringify(result.value?.nameDeclined ?? null);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(14)} parentName=${JSON.stringify(parentName)} nameDeclined=${declined}`,
    );
  }

  const spent = totalUsd(cost);
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${spent.toFixed(4)} USD`,
  );
  if (process.env.HALE_SPEND_LEDGER) {
    const ledger = readLedger();
    console.info(
      `ledger spent $${ledger.spentUsd.toFixed(4)} | calls ${ledger.calls} | cap $${HARD_CAP_USD}`,
    );
  }
  if (isDryRun()) {
    console.info(dryReportLine('name-takeback'));
    process.exit(0);
  }
  console.info(`overall: ${failed === 0 ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(failed === 0 ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--estimate')) {
    await estimate();
    return;
  }
  await record();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
