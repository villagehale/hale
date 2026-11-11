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
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import { NAME_ASK_STORED } from './lib/name-ask-stored.mjs';

const HARD_CAP_USD = 2;
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const VOICE_SRC = join(WEB_ROOT, 'lib', 'channel', 'intake', 'friend-voice.ts');
const GROUP_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group.ts');
/** linqFromE164 is env-read in production; a 555 number stands in. */
const LINE = '+1 555-555-0100';

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = judgePrompt('household-group');

// Deterministic broken stand-in: the completion claim this ticket forbids.
const BROKEN_REPLY =
  "Perfect, you're all set up and everything is in place. Mia's other parent is in.";

function inputFor(voice, phrase, fixture) {
  const { join: wantsJoin, ...over } = fixture.over;
  const base = voice.nameAskVoiceInput(over.parentWords, over.language ?? 'en', NAME_ASK_STORED);
  const coparentJoin = wantsJoin ? { line: LINE, phrase } : null;
  return { ...base, ...over, coparentJoin };
}

/**
 * What speakFriend sends after the first draw was refused: the refusal is replayed as the
 * composer's throw, and its rewrite is drawn as createFriendVoiceComposer draws it.
 */
async function sentAfterRefusal(
  agent,
  voice,
  input,
  tag,
  refusal,
  { cachedOnly, getClient, cost },
) {
  let calls = 0;
  const composer = {
    async compose(turn, options) {
      calls += 1;
      if (calls === 1) throw refusal;
      const { skill, extras } = await voice.friendVoiceSystem(turn, options?.prompt === 'short');
      const drawn = await cachedToolCall({
        tag: `${tag}:rewrite`,
        lane: agent.pickLane(skill.meta.task),
        system: skill.instructions,
        systemExtras: extras,
        cacheTtl: '1h',
        userMessage: JSON.stringify(voice.friendVoiceContext(turn)),
        toolName: voice.ONBOARDING_REPLY_TOOL,
        toolDescription: voice.ONBOARDING_REPLY_TOOL_DESCRIPTION,
        toolSchema: voice.onboardingReplyToolSchema(turn),
        maxTokens: voice.ONBOARDING_REPLY_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      return voice.parseReplyTool(drawn.value);
    },
  };
  const spoken = await voice.speakFriend(composer, input, { page: async () => undefined });
  return spoken.source === 'unsent' ? '' : spoken.body;
}

async function main() {
  assertRunFlags(['--env-file', '--max-usd', '--broken']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  if (process.argv.includes('--live')) {
    const cap = readCapUsd();
    if (cap === null || cap > HARD_CAP_USD) {
      console.error(
        `household-group: --live needs --max-usd at most ${HARD_CAP_USD}. nothing run.`,
      );
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
    const { skill, extras } = await voice.friendVoiceSystem(input, false);
    const context = voice.friendVoiceContext(input);
    let reply = BROKEN_REPLY;
    let refused = null;
    if (!broken) {
      const tag = `household-group:${fixture.id}`;
      const result = await cachedToolCall({
        tag,
        lane: agent.pickLane(skill.meta.task),
        system: skill.instructions,
        systemExtras: extras,
        cacheTtl: '1h',
        userMessage: JSON.stringify(context),
        toolName: voice.ONBOARDING_REPLY_TOOL,
        toolDescription: voice.ONBOARDING_REPLY_TOOL_DESCRIPTION,
        toolSchema: voice.onboardingReplyToolSchema(),
        maxTokens: voice.ONBOARDING_REPLY_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      }).catch((err) => {
        if (err?.name !== 'StructuredOutputError') throw err;
        return { refusal: err };
      });
      if (result.refusal) {
        // Production refuses this draw (VIL-645), so speakFriend writes its one rewrite and
        // the parent gets what that sends, or nothing.
        refused = result.refusal.outcome;
        reply = await sentAfterRefusal(agent, voice, input, tag, result.refusal, {
          cachedOnly,
          getClient,
          cost,
        });
      } else {
        reply = String(result.value?.reply ?? '');
      }
    }
    if (refused && reply === '') {
      results.push({ fixture, reply, failures: [`refused:${refused}, rewrite unsent`] });
      continue;
    }
    const verdict = await judge(fixture.id, {
      facts: context.facts,
      step: input.step,
      parentWords: input.parentWords,
      reply,
      watchFor: fixture.watchFor,
    });
    const failures =
      verdict.score < JUDGE_MIN ? [`judge:${verdict.score} (${verdict.reason})`] : [];
    if (refused)
      console.log(`      ${fixture.id}: first draw refused (${refused}); graded the rewrite`);
    results.push({ fixture, reply, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} "${r.reply}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('household-group', [judge.plan]));
    process.exit(0);
  }
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
