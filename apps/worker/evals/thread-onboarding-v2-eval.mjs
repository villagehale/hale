// VIL-721 · the in-thread onboarding walk, lit (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/onboarding-friend.md plus the lit addendum
// onboarding-friend-thread-v2.md, called with the same system, tool, schema and lane
// as createFriendVoiceComposer builds them while THREAD_ONBOARDING_V2_ENABLED is on.
// Grades the activities ask and its reading, the ONE Google link's ask (both
// connectors, the unverified-app heads-up, sendable under the production judge), a
// yes and a question to it, and the one-link wow line.
//
// The flag is read through the product's own reader, never from process.env here, so
// the operator turns it on for the run (with COLD_START_LADDER_ENABLED, the friend walk
// it rides). Recording is pending (VIL-721): CI does not run
// this suite until its cache is committed.
//
//   THREAD_ONBOARDING_V2_ENABLED=true COLD_START_LADDER_ENABLED=true node evals/thread-onboarding-v2-eval.mjs --estimate
//   THREAD_ONBOARDING_V2_ENABLED=true COLD_START_LADDER_ENABLED=true node evals/thread-onboarding-v2-eval.mjs --dry
//   THREAD_ONBOARDING_V2_ENABLED=true COLD_START_LADDER_ENABLED=true HALE_SPEND_LEDGER=... node --env-file=... \
//     evals/thread-onboarding-v2-eval.mjs --live --max-usd 1
//   THREAD_ONBOARDING_V2_ENABLED=true COLD_START_LADDER_ENABLED=true node evals/thread-onboarding-v2-eval.mjs --cached-only

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
import { THREAD_V2_FIXTURES, threadV2Misses } from './thread-onboarding-v2-fixtures.mjs';

const HARD_CAP_USD = 1;
const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'onboarding-friend.md');
const VOICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'intake', 'friend-voice.ts');
const FLAG_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'intake',
  'thread-onboarding-v2.ts',
);

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** The blank turn friend-voice tests start from, with the fixture's turn on top. */
function inputFor(fixture) {
  return {
    language: 'en',
    address: 'tu',
    introduce: false,
    parentWords: '',
    recentTurns: [],
    placeLabel: null,
    agesLabel: null,
    ageMonths: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
    ...fixture.over,
  };
}

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

async function loadSubject() {
  const flag = await importTs(FLAG_SRC);
  if (!flag.threadOnboardingV2Enabled()) {
    console.error(
      'thread-onboarding-v2: the lit walk needs THREAD_ONBOARDING_V2_ENABLED and COLD_START_LADDER_ENABLED exactly true; this suite grades it. nothing run.',
    );
    process.exit(2);
  }
  const agent = await importTs(AGENT_SRC);
  const voice = await importTs(VOICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  return { voice, lane };
}

async function estimate() {
  const { voice, lane } = await loadSubject();
  const price = PRICE[lane.model];
  if (!price) throw new Error(`no list price for ${lane.model}`);
  let usd = 0;
  for (const fixture of THREAD_V2_FIXTURES) {
    const input = inputFor(fixture);
    const tokens =
      estimateTokens((await voice.friendVoiceSystem(input, false)).system) +
      estimateTokens(JSON.stringify(voice.friendVoiceContext(input))) +
      estimateTokens(voice.onboardingReplyToolSchema(input));
    usd += (tokens / 1e6) * price.input + (voice.onboardingReplyMaxTokens() / 1e6) * price.output;
  }
  console.info(
    `thread-onboarding-v2: estimate to record ${THREAD_V2_FIXTURES.length} fixtures on ${lane.model}, priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD. Approved cap $${HARD_CAP_USD}.`,
  );
  if (usd > HARD_CAP_USD) process.exit(1);
}

async function record() {
  assertRunFlags(['--env-file', '--max-usd']);
  if (process.argv.includes('--live')) {
    const cap = readCapUsd();
    if (cap === null || cap > HARD_CAP_USD) {
      console.error(
        `thread-onboarding-v2: --live needs --max-usd at most ${HARD_CAP_USD}. nothing run.`,
      );
      process.exit(2);
    }
    if (!process.env.HALE_SPEND_LEDGER) {
      console.error('thread-onboarding-v2: set HALE_SPEND_LEDGER. nothing run.');
      process.exit(2);
    }
  }
  installEvalSpendCap();
  const getClient = lazyAnthropic('thread-onboarding-v2');
  const cost = makeCost();
  const cachedOnly = process.argv.includes('--cached-only');
  const { voice, lane } = await loadSubject();

  let failed = 0;
  for (const fixture of THREAD_V2_FIXTURES) {
    const input = inputFor(fixture);
    const tag = `thread-onboarding-v2:${fixture.id}`;
    const result = await cachedToolCall({
      tag,
      lane,
      system: (await voice.friendVoiceSystem(input, false)).system,
      userMessage: JSON.stringify(voice.friendVoiceContext(input)),
      toolName: voice.ONBOARDING_REPLY_TOOL,
      toolDescription: voice.ONBOARDING_REPLY_TOOL_DESCRIPTION,
      toolSchema: voice.onboardingReplyToolSchema(input),
      maxTokens: voice.onboardingReplyMaxTokens(),
      cachedOnly,
      getClient,
      cost,
    }).catch((err) => {
      // A draw production refuses (call markup in a field) is that refusal, named.
      if (err?.name !== 'StructuredOutputError') throw err;
      return { refused: err.outcome, value: null };
    });
    if (result.dry) {
      console.info(`DRY   ${fixture.id}`);
      continue;
    }
    if (result.refused) {
      failed += 1;
      console.info(`FAIL  ${fixture.id.padEnd(28)} refused:${result.refused}`);
      continue;
    }
    // The production judge for this step, with the link this turn carries.
    const judged = fixture.sendable
      ? voice.judgeFriendReply(String(result.value?.reply ?? ''), input, {
          linkFollows: fixture.linkFollows === true,
          linkAbove: fixture.linkAbove === true,
          ahaMention: result.value?.ahaMention ?? null,
          yesToLink: result.value?.connectGoogle === true && input.step === 'google',
          offered: result.value?.connectorsOffered,
        })
      : null;
    const misses = threadV2Misses(fixture, result.value, { judged });
    if (misses.length > 0) failed += 1;
    console.info(
      `${(misses.length === 0 ? 'PASS' : 'FAIL').padEnd(5)} ${fixture.id.padEnd(28)} ${misses.join(' ')}`,
    );
    console.info(`      reply: ${JSON.stringify(result.value?.reply ?? null)}`);
  }

  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (process.env.HALE_SPEND_LEDGER) {
    const ledger = readLedger();
    console.info(
      `ledger spent $${ledger.spentUsd.toFixed(4)} | calls ${ledger.calls} | cap $${HARD_CAP_USD}`,
    );
  }
  if (isDryRun()) {
    console.info(dryReportLine('thread-onboarding-v2'));
    process.exit(0);
  }
  console.info(`overall: ${failed === 0 ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv.includes('--estimate')) {
  await estimate();
} else {
  await record().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
