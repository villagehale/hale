// The household group in the onboarding reply · VIL-566 (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/onboarding-friend.md plus the household-group addendum,
// composed by the REAL friendVoiceSystem and friendVoiceContext from
// apps/web/lib/channel/intake/friend-voice.ts, with the same tool, schema and lane as
// createFriendVoiceComposer. A yes to the group is not the group: while no group is
// claimed, the reply does not say setup is done; once one is, it does not say the group
// is still to come.
//
//   HALE_SPEND_LEDGER=... node --env-file=... evals/run-household-group-eval.mjs --live --max-usd 2
//   node evals/run-household-group-eval.mjs --live --broken --max-usd 2   # calibration: must FAIL
//   node evals/run-household-group-eval.mjs --cached-only                 # CI: replay only
//
// THE HARD ZERO: any reply the judge scores under JUDGE_MIN.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { readCapUsd } from '../../web/lib/testing/spend-cap.mjs';
import { HOUSEHOLD_GROUP_FIXTURES } from './household-group-fixtures.mjs';
import {
  JUDGE_MIN,
  REPO_ROOT,
  assertRunFlags,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HARD_CAP_USD = 2;
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const VOICE_SRC = join(WEB_ROOT, 'lib', 'channel', 'intake', 'friend-voice.ts');
const GROUP_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group.ts');
/** linqFromE164 is env-read in production; a 555 number stands in. */
const LINE = '+1 555-555-0100';

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE onboarding text Hale (a kids-year planner that lives',
  'in iMessage and SMS) sends a parent. You get the facts Hale was given, the reply, and',
  'watchFor - fixture-specific notes on what right and wrong look like.',
  '`facts.householdGroup` is where the group chat with the other parent stands: `unclaimed`',
  '(no group yet; a yes in this message leaves it pending), `pending` (they said yes; no group',
  'exists yet), `claimed` (the group exists).',
  'A LOW score (1-2) is any of: while the group is unclaimed or pending, saying or suggesting',
  'that setup is done, finished, complete, all set, everything is in place, or the like, in any',
  'language; saying the other parent has joined, is in the group, or can see anything; when',
  'claimed, saying the group still has to be made or set up; a phone number or link written in',
  'the reply; anything watchFor says must not happen.',
  'Saying Hale has what it needs for the kids, or will text when something matters, is NOT a',
  'claim that setup is done.',
  'A 5 is short, plain and warm, answers what they said, and makes none of those claims.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: the completion claim this ticket forbids.
const BROKEN_REPLY = "Perfect, you're all set up and everything is in place. Mia's other parent is in.";

function inputFor(voice, phrase, fixture) {
  const { join: wantsJoin, ...over } = fixture.over;
  const base = voice.nameAskVoiceInput(over.parentWords, over.language ?? 'en');
  const coparentJoin = wantsJoin ? { line: LINE, phrase } : null;
  return { ...base, ...over, coparentJoin };
}

async function main() {
  assertRunFlags(['--env-file', '--max-usd', '--broken']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  if (process.argv.includes('--live')) {
    const cap = readCapUsd();
    if (cap === null || cap > HARD_CAP_USD) {
      console.error(`household-group: --live needs --max-usd at most ${HARD_CAP_USD}. nothing run.`);
      process.exit(2);
    }
  }
  installEvalSpendCap();
  const getClient = lazyAnthropic('household-group');
  const cost = makeCost();

  const agent = await importTs(AGENT_SRC);
  const voice = await importTs(VOICE_SRC);
  const { LINQ_GROUP_TRIGGER_PHRASE } = await importTs(GROUP_SRC);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'household-group', cachedOnly, getClient, cost);

  console.log(
    `household-group eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of HOUSEHOLD_GROUP_FIXTURES) {
    process.env.LINQ_GROUP_ONBOARDING_V2_ENABLED = fixture.v2 ? 'true' : 'false';
    const phrase =
      fixture.over.language === 'fr' ? LINQ_GROUP_TRIGGER_PHRASE.fr : LINQ_GROUP_TRIGGER_PHRASE.en;
    const input = inputFor(voice, phrase, fixture);
    const { skill, system } = await voice.friendVoiceSystem(input, false);
    const context = voice.friendVoiceContext(input);
    let reply = BROKEN_REPLY;
    if (!broken) {
      const result = await cachedToolCall({
        tag: `household-group:${fixture.id}`,
        lane: agent.pickLane(skill.meta.task),
        system,
        userMessage: JSON.stringify(context),
        toolName: voice.ONBOARDING_REPLY_TOOL,
        toolDescription: voice.ONBOARDING_REPLY_TOOL_DESCRIPTION,
        toolSchema: voice.onboardingReplyToolSchema(),
        maxTokens: voice.ONBOARDING_REPLY_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      reply = String(result.value?.reply ?? '');
    }
    const verdict = await judge(fixture.id, {
      facts: context.facts,
      step: input.step,
      parentWords: input.parentWords,
      reply,
      watchFor: fixture.watchFor,
    });
    const failures = verdict.score < JUDGE_MIN ? [`judge:${verdict.score} (${verdict.reason})`] : [];
    results.push({ fixture, reply, failures });
  }

  for (const r of results) {
    console.log(`${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} "${r.reply}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  console.log(
    `broken-mode calibration (must fail at least one): ${allPass ? 'FAIL (exit 1)' : 'PASS (exit 0)'}`,
  );
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('household-group eval harness error:', err);
  process.exit(2);
});
