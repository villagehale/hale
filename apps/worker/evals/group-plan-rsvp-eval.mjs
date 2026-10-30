// Group plan RSVP · reader + voice eval (VIL-442, hard rule #8: no LLM mocking).
//
// The subjects are the REAL skills through the REAL request shapes:
//   packages/agent/skills/group-plan-rsvp-read.md  + groupPlanRsvpUserMessage
//   packages/agent/skills/group-plan-rsvp-voice.md + groupPlanRsvpLineInput
// A judge scores meaning, 1-5. No word-matching gate.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up.
// It is not in ci.yml. There is no committed cache. A miss must not spend.
//
//   node evals/group-plan-rsvp-eval.mjs --estimate
//   node evals/group-plan-rsvp-eval.mjs --cached-only
//
// --estimate prices one live recording of every fixture (reader + voice + judge)
// at max_tokens and exits 0. It does not call the API and it does not write cache.
// --cached-only replays committed cache. The first miss prints that same estimate
// and exits 1.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  GROUP_PLAN_RSVP_READ_FIXTURES,
  GROUP_PLAN_RSVP_VOICE_FIXTURES,
} from './group-plan-rsvp-fixtures.mjs';
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

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const READ_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-plan-rsvp-read.md');
const VOICE_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-plan-rsvp-voice.md');
const READING_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'group-plan-rsvp',
  'reading.ts',
);
const FACTS_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'group-plan-rsvp',
  'facts.ts',
);
const TALLY_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'group-plan-rsvp',
  'tally.ts',
);
const VOICE_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'linq',
  'group-plan-rsvp',
  'voice.ts',
);

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_REASON_MAX_CHARS = 160;
const JUDGE_TOOL_SCHEMA = scoreFirstJudgeSchema(JUDGE_REASON_MAX_CHARS);
const JUDGE_MAX_TOKENS = 440;

const READ_JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE reading of a group-chat message about a shared plan.',
  'You are given `situation` and `reading`. `reading` is the model tool output: intent,',
  'response, headcount, householdLabel, coversNames, confidence. Score 1-5 on MEANING.',
  'Do not require particular words. A 5 matches the situation. A 1 or 2 is the wrong intent',
  '(a vote read as chatter, chatter read as a vote, a household answer missing the household).',
  'Reply with ONLY the score tool. score first, then reason. Reason at most',
  `${JUDGE_REASON_MAX_CHARS} characters.`,
].join(' ');

const VOICE_JUDGE_SYSTEM = [
  "You are a strict reviewer scoring ONE message Hale posts in a group chat about a plan it is tracking.",
  'You are given `situation`, `watchFor`, `facts`, and `message`. Score 1-5 on FACTS and TONE, not wording.',
  'A 5 gets the yes / no / waiting picture and the deadline from facts, in its own words, short and plain.',
  'A LOW score invents a calendar, a poll, a button, a reply keyword, a name or number not in facts,',
  'or claims Hale can see email or a private calendar. Reply with ONLY the score tool.',
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

function suiteUsd({ readLane, voiceLane, readSkill, voiceSkill, reading, facts, tally, voice, judgeModel }) {
  let usd = 0;
  for (const fixture of GROUP_PLAN_RSVP_READ_FIXTURES) {
    const userMessage = reading.groupPlanRsvpUserMessage(fixture.input);
    const input =
      estimateTokens(readSkill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: 'group_plan_rsvp',
        input_schema: reading.GROUP_PLAN_RSVP_READ_TOOL_SCHEMA,
      });
    usd += priced(readLane.model, input, reading.GROUP_PLAN_RSVP_READ_MAX_TOKENS);
    usd += priced(
      judgeModel,
      estimateTokens(READ_JUDGE_SYSTEM) +
        estimateTokens({ situation: fixture.situation, reading: { intent: 'chatter' } }) +
        estimateTokens(JUDGE_TOOL),
      JUDGE_MAX_TOKENS,
    );
  }
  const emptyTally = tally.tallyPlanRsvps([], []);
  for (const fixture of GROUP_PLAN_RSVP_VOICE_FIXTURES) {
    const input = facts.groupPlanRsvpLineInput({
      kind: fixture.kind,
      language: 'en',
      title: fixture.kind === 'follow_up' ? 'soccer Saturday' : 'Saturday picnic',
      deadline: fixture.kind === 'tally' ? 'Friday' : null,
      tally: emptyTally,
    });
    const userMessage = JSON.stringify(input);
    usd += priced(
      voiceLane.model,
      estimateTokens(voiceSkill.instructions) + estimateTokens(userMessage),
      voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS,
    );
    usd += priced(
      judgeModel,
      estimateTokens(VOICE_JUDGE_SYSTEM) +
        estimateTokens({ situation: fixture.situation, watchFor: fixture.watchFor, facts: input.facts, message: '' }) +
        estimateTokens(JUDGE_TOOL) +
        voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS,
      JUDGE_MAX_TOKENS,
    );
  }
  return usd;
}

function estimateLine(usd) {
  return `group-plan-rsvp: one estimate to record ${GROUP_PLAN_RSVP_READ_FIXTURES.length} reader fixtures and ${GROUP_PLAN_RSVP_VOICE_FIXTURES.length} voice fixtures (subject + judge), priced at max_tokens. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`;
}

async function main() {
  const estimateOnly = process.argv.includes('--estimate');
  const cachedOnly = process.argv.includes('--cached-only');
  if (estimateOnly && cachedOnly) {
    console.error('group-plan-rsvp: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  if (!estimateOnly && !cachedOnly) {
    console.error(
      'group-plan-rsvp: pass --estimate or --cached-only. This runner does not call the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const reading = await importTs(READING_SRC);
  const facts = await importTs(FACTS_SRC);
  const tally = await importTs(TALLY_SRC);
  const voice = await importTs(VOICE_SRC);
  const readSkill = await agent.loadSkill(READ_SKILL_PATH);
  const voiceSkill = await agent.loadSkill(VOICE_SKILL_PATH);
  const readLane = agent.pickLane(readSkill.meta.task);
  const voiceLane = agent.pickLane(voiceSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = suiteUsd({
    readLane,
    voiceLane,
    readSkill,
    voiceSkill,
    reading,
    facts,
    tally,
    voice,
    judgeModel,
  });

  if (estimateOnly) {
    console.info(estimateLine(usd));
    return;
  }

  for (const fixture of GROUP_PLAN_RSVP_READ_FIXTURES) {
    const canonical = JSON.stringify({
      system: readSkill.instructions,
      userMessage: reading.groupPlanRsvpUserMessage(fixture.input),
      toolName: 'group_plan_rsvp',
      toolSchema: reading.GROUP_PLAN_RSVP_READ_TOOL_SCHEMA,
      maxTokens: reading.GROUP_PLAN_RSVP_READ_MAX_TOKENS,
    });
    const key = cacheKey(evalRunTag(`group-plan-rsvp-read:${fixture.id}`), canonical);
    const cached = await cacheGet(key);
    if (!cached) {
      console.error(estimateLine(usd));
      console.error(`group-plan-rsvp: cache miss on ${fixture.id}. stopped. nothing recorded.`);
      process.exit(1);
    }
    const judged = cacheKey(
      `group-plan-rsvp-read:judge:${fixture.id}`,
      `${judgeModel}\n${READ_JUDGE_SYSTEM}\n${JSON.stringify({ situation: fixture.situation, reading: cached.value })}`,
    );
    const verdict = await cacheGet(judged);
    if (!verdict || !isVerdict(verdict.parsed)) {
      console.error(estimateLine(usd));
      console.error(`group-plan-rsvp: judge cache miss on ${fixture.id}. stopped. nothing recorded.`);
      process.exit(1);
    }
    const score = verdict.parsed.score;
    const ok = score >= JUDGE_MIN && fixture.accept.includes(cached.value.intent);
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  intent=${cached.value.intent} judge:${score}`);
    if (!ok) process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'group-plan-rsvp failed');
    process.exit(1);
  });
}

export { estimateLine, main, suiteUsd };
