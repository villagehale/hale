// The onboarding reply's decision fields (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/onboarding-friend.md, called with the same
// tool, schema and lane as createFriendVoiceComposer. friend-voice.ts reads
// `asks`, `parentQuestion`, `connectorsOffered` and `joinPointer` instead of
// matching '?' or English/French words. This checks the model returns them on
// the turns where the send depends on them, with the right value: a Chinese
// question is `parentQuestion` and no question is kept as a yes, a calendar
// reply that offers Gmail lists it, a co-parent yes points `below`, a receipt
// does not ask.
//
// The group-onboarding flag is pinned off: the join pointer is only read
// there (flag on writes the group choice itself). CI replays these requests.
//
//   node evals/friend-marks-eval.mjs --estimate
//   HALE_SPEND_LEDGER=... node --env-file=... evals/friend-marks-eval.mjs --live --max-usd 2
//   node evals/friend-marks-eval.mjs --cached-only

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { readCapUsd, readLedger } from '../../web/lib/testing/spend-cap.mjs';
import { FRIEND_MARKS_FIXTURES, friendMarksMisses } from './friend-marks-fixtures.mjs';
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
import { NAME_ASK_STORED } from './lib/name-ask-stored.mjs';

const HARD_CAP_USD = 2;
const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'onboarding-friend.md');
// The one retry (VIL-538): the French reply and the false "saved" were both its draft.
const SHORT_SKILL_PATH = join(
  REPO_ROOT,
  'packages',
  'agent',
  'skills',
  'onboarding-friend-short.md',
);
const VOICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'intake', 'friend-voice.ts');

process.env.LINQ_GROUP_ONBOARDING_V2_ENABLED = 'false';

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function inputFor(voice, fixture) {
  const base = voice.nameAskVoiceInput(
    fixture.over.parentWords,
    fixture.over.language ?? 'en',
    NAME_ASK_STORED,
  );
  const input = { ...base, ...fixture.over };
  if (!fixture.retry) return input;
  // With askNote the retry is briefed as speakFriend briefs it: the problem, for this
  // step, then what the message should ask. Older fixtures keep their recorded bytes.
  const problem = fixture.retry.askNote
    ? `${voice.retryProblem(fixture.retry.reason, undefined, input)} This message should ${voice.askInWords(input.step)}.`
    : voice.retryProblem(fixture.retry.reason);
  return { ...input, retry: { draft: fixture.retry.draft, problem } };
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
  const agent = await importTs(AGENT_SRC);
  const voice = await importTs(VOICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const shortSkill = await agent.loadSkill(SHORT_SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  return { voice, skill, shortSkill, lane };
}

async function estimate() {
  const { skill, shortSkill, voice, lane } = await loadSubject();
  const price = PRICE[lane.model];
  if (!price) throw new Error(`no list price for ${lane.model}`);
  let usd = 0;
  for (const fixture of FRIEND_MARKS_FIXTURES) {
    const input =
      estimateTokens((fixture.prompt === 'short' ? shortSkill : skill).instructions) +
      estimateTokens(JSON.stringify(voice.friendVoiceContext(inputFor(voice, fixture)))) +
      estimateTokens(voice.onboardingReplyToolSchema());
    usd += (input / 1e6) * price.input + (voice.ONBOARDING_REPLY_MAX_TOKENS / 1e6) * price.output;
  }
  console.info(
    `friend-marks: estimate to record ${FRIEND_MARKS_FIXTURES.length} fixtures on ${lane.model}, priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD. Approved cap $${HARD_CAP_USD}.`,
  );
  if (usd > HARD_CAP_USD) process.exit(1);
}

async function record() {
  assertRunFlags(['--env-file', '--max-usd']);
  if (process.argv.includes('--live')) {
    const cap = readCapUsd();
    if (cap === null || cap > HARD_CAP_USD) {
      console.error(`friend-marks: --live needs --max-usd at most ${HARD_CAP_USD}. nothing run.`);
      process.exit(2);
    }
    if (!process.env.HALE_SPEND_LEDGER) {
      console.error('friend-marks: set HALE_SPEND_LEDGER. nothing run.');
      process.exit(2);
    }
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('friend-marks');
  const cost = makeCost();
  const cachedOnly = process.argv.includes('--cached-only');
  const { skill, shortSkill, voice, lane } = await loadSubject();

  let failed = 0;
  for (const fixture of FRIEND_MARKS_FIXTURES) {
    const result = await cachedToolCall({
      tag: `friend-marks:${fixture.id}`,
      lane,
      system: (fixture.prompt === 'short' ? shortSkill : skill).instructions,
      userMessage: JSON.stringify(voice.friendVoiceContext(inputFor(voice, fixture))),
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
    const input = inputFor(voice, fixture);
    const kept = fixture.groupBubbles
      ? (
          voice.findShowGroupBubbles(
            voice.readGroupLeads(result.value?.groupLeads),
            input.findGroups,
            input,
          ) ?? []
        ).filter((bubble) => bubble.length > 0).length
      : 0;
    // A reply code would send: the same judge speakFriend runs, for this step.
    const judged = fixture.sendable
      ? voice.judgeFriendReply(String(result.value?.reply ?? ''), input)
      : null;
    const misses = friendMarksMisses(fixture, result.value, { keptGroupBubbles: kept, judged });
    if (misses.length > 0) failed += 1;
    console.info(
      `${misses.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(24)} ${misses.join(' ')}`,
    );
    if (fixture.printReply || fixture.groupBubbles)
      console.info(`      reply: ${JSON.stringify(result.value?.reply ?? null)}`);
    if (fixture.groupBubbles)
      console.info(`      groupLeads: ${JSON.stringify(result.value?.groupLeads ?? null)}`);
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
    console.info(dryReportLine('friend-marks'));
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
