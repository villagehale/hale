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
  JUDGE_MIN,
  PRICE,
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
// A declined place is graded on meaning (VIL-641): fixtures with `watchFor` are judged.
const PLACE_JUDGE_SYSTEM = judgePrompt('friend-place');
// A conditional ("your ZIP would let me look near you") is not an empty promise; the
// Haiku judge read it as one against its own rubric, so this judge is the Sonnet tier.
const PLACE_JUDGE_TIER = 'sonnet';
/** Judge input ceiling per verdict, for the estimate. */
const JUDGE_ESTIMATE_OUTPUT_TOKENS = 4096;

process.env.LINQ_GROUP_ONBOARDING_V2_ENABLED = 'false';
// Regex judge path: the meaning-screen sweep is its own eval.
process.env.MODEL_READ_SWEEP_ENABLED = 'false';

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
    ? `${voice.retryProblem(fixture.retry.reason, undefined, input)} This message should ${voice.askInWords(input.step, input)}.`
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

/**
 * A draw production refuses (VIL-645: call markup the model wrote into a field) is
 * replayed as that refusal, named, never graded and never a crash of the whole run.
 */
function refusal(err) {
  if (err?.name !== 'StructuredOutputError') throw err;
  return { refused: err.outcome, value: null };
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
      estimateTokens(voice.onboardingReplyToolSchema(inputFor(voice, fixture)));
    // A turn graded through code may draw its one rewrite too.
    const draws = fixture.throughCode ? 2 : 1;
    usd +=
      draws *
      ((input / 1e6) * price.input + (voice.ONBOARDING_REPLY_MAX_TOKENS / 1e6) * price.output);
    if (fixture.watchFor) {
      const judgePrice = PRICE[await readJudgeModel(PLACE_JUDGE_TIER)];
      if (!judgePrice) throw new Error('no list price for the judge model');
      const judgeInput = estimateTokens(PLACE_JUDGE_SYSTEM) + 2000;
      usd +=
        (judgeInput / 1e6) * judgePrice.input +
        (JUDGE_ESTIMATE_OUTPUT_TOKENS / 1e6) * judgePrice.output;
    }
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
  const { voice, lane } = await loadSubject();
  const judge = makeJudge(
    await readJudgeModel(PLACE_JUDGE_TIER),
    PLACE_JUDGE_SYSTEM,
    'friend-marks',
    cachedOnly,
    getClient,
    cost,
  );

  // Prefix before the cache breakpoint, per-turn addendums after it (as the live composer).
  const draw = async (turn, prompt, tag) => {
    const { skill, extras } = await voice.friendVoiceSystem(turn, prompt === 'short');
    return cachedToolCall({
      tag,
      lane,
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
  };

  let failed = 0;
  // A metric, not a gate: how often speakFriend refused the first draft and rewrote it.
  const firstDrafts = { graded: 0, refused: 0 };
  for (const fixture of FRIEND_MARKS_FIXTURES) {
    const input = inputFor(voice, fixture);
    const tag = `friend-marks:${fixture.id}`;
    let result;
    let sent = null;
    const draws = [];
    if (fixture.throughCode) {
      // speakFriend itself runs on the recorded draws: its refusal and its one rewrite
      // are the code under test, and the reply graded is the one it would send.
      const composer = {
        async compose(turn, options) {
          const prompt = options?.prompt === 'short' ? 'short' : 'full';
          const drawn = await draw(turn, prompt, draws.length === 0 ? tag : `${tag}:rewrite`).catch(
            (err) => {
              // Refused as production refuses it: speakFriend gets the throw and rewrites.
              draws.push(refusal(err));
              throw err;
            },
          );
          draws.push(drawn);
          if (drawn.dry) throw new Error('dry run');
          return voice.parseReplyTool(drawn.value);
        },
      };
      const spoken = await voice.speakFriend(composer, input, { page: async () => undefined });
      // The fields graded are the sent draw's, as production keeps them.
      result = spoken.source === 'retry' ? draws[draws.length - 1] : draws[0];
      firstDrafts.graded += 1;
      if (draws.length > 1) firstDrafts.refused += 1;
      sent = {
        source: spoken.source,
        placeDeclined: spoken.capture.placeDeclined,
        body: spoken.body,
      };
    } else {
      result = await draw(input, fixture.prompt === 'short' ? 'short' : 'full', tag).catch(refusal);
      if (result.refused) {
        failed += 1;
        console.info(`FAIL  ${fixture.id.padEnd(24)} refused:${result.refused}`);
        continue;
      }
    }
    if (result.dry) {
      console.info(`DRY   ${fixture.id}`);
      continue;
    }
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
    const context = voice.friendVoiceContext(input);
    const meaning = fixture.watchFor
      ? await judge(fixture.id, {
          facts: context.facts,
          step: input.step,
          recentTurns: input.recentTurns,
          parentWords: input.parentWords,
          reply: sent ? sent.body : String(result.value?.reply ?? ''),
          watchFor: fixture.watchFor,
        })
      : null;
    if (meaning?.dry) continue;
    const misses = friendMarksMisses(fixture, result.value, {
      keptGroupBubbles: kept,
      judged,
      meaning,
      meaningMin: JUDGE_MIN,
      sent,
    });
    if (misses.length > 0) failed += 1;
    console.info(
      `${(misses.length === 0 ? 'PASS' : 'FAIL').padEnd(5)} ${fixture.id.padEnd(24)} ${misses.join(' ')}`,
    );
    if (draws[0]?.refused) console.info(`      first draw refused: ${draws[0].refused}`);
    else if (fixture.printReply || fixture.groupBubbles)
      console.info(`      reply: ${JSON.stringify((draws[0] ?? result).value?.reply ?? null)}`);
    if (draws.length > 1) {
      console.info(`      rewrite: ${JSON.stringify(draws[1]?.value?.reply ?? null)}`);
    }
    if (sent) console.info(`      sent (${sent.source}): ${JSON.stringify(sent.body)}`);
    if (fixture.groupBubbles)
      console.info(`      groupLeads: ${JSON.stringify(result.value?.groupLeads ?? null)}`);
  }

  console.info(
    `first drafts refused and rewritten: ${firstDrafts.refused} of ${firstDrafts.graded} turns graded through code`,
  );
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
