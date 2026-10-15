// Weekday-care reply eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/weekday-care-reply.md, called the way the runtime
// calls it (apps/web/lib/channel/weekday-care/reply.ts): the weekday_care_reply tool
// forced on the skill's lane. The runner does not assert a care enum or a phrase.
// A judge scores the tool output against a situation.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up.
// It is not in ci.yml. There is no committed cache. A miss must not spend.
//
//   node evals/weekday-care-reply-eval.mjs --estimate
//   node evals/weekday-care-reply-eval.mjs --cached-only
//
// --estimate prices the whole suite at the gate ceiling and exits 0. It does not
// call the API and it does not write a cache file.
// --cached-only replays committed cache. The first miss prints that same one
// estimate and exits 1. It does not call the API and it does not write anything.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  PRICE,
  REPO_ROOT,
  cacheGet,
  cacheKey,
  evalRunTag,
  isVerdict,
  readJudgeModel,
  scoreFirstJudgeSchema,
} from './lib/harness.mjs';
import { WEEKDAY_CARE_REPLY_FIXTURES } from './weekday-care-reply-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'weekday-care-reply.md');
const REPLY_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'weekday-care', 'reply.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_REASON_MAX_CHARS = 160;
const JUDGE_TOOL_SCHEMA = scoreFirstJudgeSchema(JUDGE_REASON_MAX_CHARS);
const JUDGE_MAX_TOKENS = 440;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE reading of a parent reply about how a child',
  'spends weekdays. You are given `situation` and `reading`. `reading` is the model',
  'tool output: care, provider, confidence, and an optional reason. Score 1-5.',
  'Call the score tool with `score` first, then `reason`. The reason is at most',
  `${JUDGE_REASON_MAX_CHARS} characters. Do not quote the parent. Do not quote the`,
  'situation.',
  'A 5 matches the situation. care is home, daycare, starting_soon, or nothing, and',
  'it is the one the situation describes. provider is present only when the situation',
  "says this child's own place was named, and it is that place. confidence is high",
  'when the situation is clear enough to file for months, and not high when the',
  'situation settles nothing. The parent may have written in any language. Grade the',
  'meaning. Do not require particular words.',
  'A 1 or 2 is the wrong care, a provider that belongs to a different child, a',
  'provider when none was named, or high confidence on a reply that settles nothing.',
  'A 3 is the right care with a confidence the runtime would not file, or a right',
  'care whose provider is missing or extra.',
  'Reply with ONLY the score tool.',
].join(' ');

const JUDGE_TOOL = {
  name: 'score',
  description: 'Return the score.',
  input_schema: JUDGE_TOOL_SCHEMA,
};

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

function writerKey(agent, lane, skill, reply, fixture) {
  const fields = agent.laneRequestFields(lane);
  const toolChoice =
    lane.model === agent.SONNET55_MODEL
      ? { type: 'auto' }
      : { type: 'tool', name: reply.WEEKDAY_CARE_REPLY_TOOL };
  const canonical = JSON.stringify({
    fields,
    system: skill.instructions,
    userMessage: reply.weekdayCareReplyUserMessage(fixture.text),
    toolName: reply.WEEKDAY_CARE_REPLY_TOOL,
    toolSchema: reply.WEEKDAY_CARE_REPLY_TOOL_SCHEMA,
    toolChoice,
    maxTokens: reply.WEEKDAY_CARE_REPLY_MAX_TOKENS,
  });
  return cacheKey(evalRunTag(`weekday-care-reply:${fixture.id}`), canonical);
}

function judgeKey(judgeModel, fixture, reading) {
  const user = JSON.stringify({ situation: fixture.situation, reading });
  return {
    key: cacheKey(
      `weekday-care-reply:judge:${fixture.id}`,
      `${judgeModel}\n${JUDGE_SYSTEM}\n${user}`,
    ),
    user,
  };
}

function suiteUsd({ lane, skill, reply, judgeModel }) {
  let usd = 0;
  for (const fixture of WEEKDAY_CARE_REPLY_FIXTURES) {
    const userMessage = reply.weekdayCareReplyUserMessage(fixture.text);
    const writerInput =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: reply.WEEKDAY_CARE_REPLY_TOOL,
        description: 'Read how this child spends weekdays.',
        input_schema: reply.WEEKDAY_CARE_REPLY_TOOL_SCHEMA,
      });
    usd += priced(lane.model, writerInput, reply.WEEKDAY_CARE_REPLY_MAX_TOKENS);
    const judgeUser = JSON.stringify({
      situation: fixture.situation,
      reading: { care: 'nothing', provider: null, confidence: 'low', reason: '' },
    });
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens(judgeUser) +
      estimateTokens(JUDGE_TOOL) +
      reply.WEEKDAY_CARE_REPLY_MAX_TOKENS;
    usd += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
  }
  return usd;
}

function estimateLine(usd) {
  return `weekday-care-reply: one estimate to record ${WEEKDAY_CARE_REPLY_FIXTURES.length} fixtures (writer + judge), priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`;
}

async function main() {
  const estimateOnly = process.argv.includes('--estimate');
  const cachedOnly = process.argv.includes('--cached-only');
  if (estimateOnly && cachedOnly) {
    console.error('weekday-care-reply: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  if (!estimateOnly && !cachedOnly) {
    console.error(
      'weekday-care-reply: pass --estimate or --cached-only. This runner does not call the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const reply = await importTs(REPLY_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = suiteUsd({ lane, skill, reply, judgeModel });

  if (estimateOnly) {
    console.info(estimateLine(usd));
    return;
  }

  for (const fixture of WEEKDAY_CARE_REPLY_FIXTURES) {
    const key = writerKey(agent, lane, skill, reply, fixture);
    const cached = await cacheGet(key);
    if (!cached) {
      console.error(estimateLine(usd));
      console.error(`weekday-care-reply: cache miss on ${fixture.id}. stopped. nothing recorded.`);
      process.exit(1);
    }
    const judged = judgeKey(judgeModel, fixture, cached.value);
    const verdict = await cacheGet(judged.key);
    if (!verdict || !isVerdict(verdict.parsed)) {
      console.error(estimateLine(usd));
      console.error(
        `weekday-care-reply: judge cache miss on ${fixture.id}. stopped. nothing recorded.`,
      );
      process.exit(1);
    }
    const score = verdict.parsed.score;
    const ok = score >= JUDGE_MIN;
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  judge:${score}`);
    if (!ok) process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'weekday-care-reply failed');
    process.exit(1);
  });
}
