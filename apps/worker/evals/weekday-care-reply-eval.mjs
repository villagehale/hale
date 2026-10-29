// Weekday-care reply eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/weekday-care-reply.md, called the way the runtime
// calls it (apps/web/lib/channel/weekday-care/reply.ts): the weekday_care_reply tool
// on the skill's lane, same system, user message, schema and max_tokens. The runner
// does not assert a care enum or a phrase. A judge reads the whole reading against a
// situation, in whatever language the parent wrote.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up.
//
//   node evals/weekday-care-reply-eval.mjs --estimate                 # price only, no API
//   node evals/weekday-care-reply-eval.mjs --max-usd <ledger + allow>  # live, then caches
//   node evals/weekday-care-reply-eval.mjs --broken                   # calibration: must FAIL
//   node evals/weekday-care-reply-eval.mjs --cached-only              # CI: replay only
//
// --estimate prices the suite at max_tokens and writes nothing.
// --cached-only replays the cache; the first miss exits 1 and writes nothing.
// A live run goes through the shared spend cap: --max-usd (or HALE_MAX_USD) is a hard
// stop against the ledger in HALE_SPEND_LEDGER, and every live call is booked there.
// --broken grades a deliberately wrong reading per fixture with the real judge. Every
// one must fail, or the judge is too lenient.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  scoreFirstJudgeSchema,
  totalUsd,
} from './lib/harness.mjs';
import {
  WEEKDAY_CARE_REPLY_BROKEN,
  WEEKDAY_CARE_REPLY_FIXTURES,
} from './weekday-care-reply-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'weekday-care-reply.md');
const REPLY_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'weekday-care', 'reply.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TOOL_DESCRIPTION = 'Read how this child spends weekdays.'; // reply.ts, verbatim
const JUDGE_REASON_MAX_CHARS = 160;
const JUDGE_TOOL_SCHEMA = scoreFirstJudgeSchema(JUDGE_REASON_MAX_CHARS);
const JUDGE_MAX_TOKENS = 440;

export const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE reading of a parent reply about how a child',
  'spends weekdays. You are given `parentText`, `situation` and `reading`. `reading` is',
  'the model tool output: care, provider, confidence, and an optional reason. Read the',
  'whole reading, reason included. Score 1-5.',
  'Call the score tool with `score` first, then `reason`. The reason is at most',
  `${JUDGE_REASON_MAX_CHARS} characters. Do not quote the parent. Do not quote the`,
  'situation.',
  'A 5 matches the situation. care is home, daycare, starting_soon, or nothing, and',
  'it is the one the situation describes. provider is present only when the situation',
  "says this child's own place was named, and it is that place, spelled as given.",
  'confidence is high when the situation is clear enough to file for months, and not',
  'high when the situation settles nothing. The parent may have written in any language',
  'or script. Grade the meaning. Do not require particular words.',
  'A 1 or 2 is any of: the wrong care; a provider that belongs to a different child or',
  "another family (that is someone else's private fact); a provider when none was",
  'named; a misspelled or invented provider; high confidence on a reply that settles',
  'nothing; a reason that invents facts the parent did not give (dates, places, people,',
  'a diagnosis or a judgement of the family), or that judges or lectures the parent.',
  'A 3 is the right care with a confidence the runtime would not file, or a right',
  'care whose provider is missing or extra.',
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

function judgePayload(fixture, reading) {
  return { parentText: fixture.text, situation: fixture.situation, reading };
}

function suiteUsd({ lane, skill, reply, judgeModel }) {
  let usd = 0;
  for (const fixture of WEEKDAY_CARE_REPLY_FIXTURES) {
    const writerInput =
      estimateTokens(skill.instructions) +
      estimateTokens(reply.weekdayCareReplyUserMessage(fixture.text)) +
      estimateTokens({
        name: reply.WEEKDAY_CARE_REPLY_TOOL,
        description: TOOL_DESCRIPTION,
        input_schema: reply.WEEKDAY_CARE_REPLY_TOOL_SCHEMA,
      });
    usd += priced(lane.model, writerInput, reply.WEEKDAY_CARE_REPLY_MAX_TOKENS);
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens(
        judgePayload(fixture, { care: 'nothing', provider: null, confidence: 'low', reason: '' }),
      ) +
      estimateTokens(JUDGE_TOOL_SCHEMA) +
      reply.WEEKDAY_CARE_REPLY_MAX_TOKENS;
    usd += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
  }
  return usd;
}

async function main() {
  const argv = process.argv;
  const estimateOnly = argv.includes('--estimate');
  const cachedOnly = argv.includes('--cached-only');
  const broken = argv.includes('--broken');
  if (estimateOnly && (cachedOnly || broken)) {
    console.error('weekday-care-reply: --estimate runs alone');
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const reply = await importTs(REPLY_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  if (estimateOnly) {
    console.info(
      `weekday-care-reply: estimate for ${WEEKDAY_CARE_REPLY_FIXTURES.length} fixtures (writer + judge) at max_tokens, $${suiteUsd({ lane, skill, reply, judgeModel }).toFixed(4)} USD. live API calls: 0. nothing written.`,
    );
    return;
  }

  if (!cachedOnly) installEvalSpendCap();
  const getClient = lazyAnthropic('weekday-care-reply');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'weekday-care-reply-judge',
    cachedOnly,
    getClient,
    cost,
    {
      toolSchema: JUDGE_TOOL_SCHEMA,
      keepTruncatedScore: true,
      maxTokens: JUDGE_MAX_TOKENS,
    },
  );

  console.info(
    `weekday-care-reply eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | subject=${lane.model} judge=${judgeModel}`,
  );
  let failed = 0;
  for (const fixture of WEEKDAY_CARE_REPLY_FIXTURES) {
    const reading = broken
      ? WEEKDAY_CARE_REPLY_BROKEN[fixture.id]
      : (
          await cachedToolCall({
            tag: `weekday-care-reply:${fixture.id}`,
            lane,
            model: lane.model,
            system: skill.instructions,
            userMessage: reply.weekdayCareReplyUserMessage(fixture.text),
            toolName: reply.WEEKDAY_CARE_REPLY_TOOL,
            toolDescription: TOOL_DESCRIPTION,
            toolSchema: reply.WEEKDAY_CARE_REPLY_TOOL_SCHEMA,
            maxTokens: reply.WEEKDAY_CARE_REPLY_MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;
    const tag = broken ? `broken:${fixture.id}` : fixture.id;
    const verdict = await judge(tag, judgePayload(fixture, reading));
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  judge:${verdict.score}`);
    console.info(`      reading: ${JSON.stringify(reading)}`);
    console.info(`      judge: ${verdict.reason ?? ''}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (broken) {
    const all = failed === WEEKDAY_CARE_REPLY_FIXTURES.length;
    console.info(
      `broken-mode calibration (every case must fail): ${all ? 'PASS' : 'FAIL'} (${failed}/${WEEKDAY_CARE_REPLY_FIXTURES.length} failed)`,
    );
    process.exit(all ? 0 : 1);
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'weekday-care-reply failed');
    process.exit(1);
  });
}
