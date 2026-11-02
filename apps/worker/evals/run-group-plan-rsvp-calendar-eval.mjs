// Group plan calendar consent · reader + voice eval (VIL-503, hard rule #8).
//
// Subjects are the production reader and the production voice, called the way
// calendar.ts and voice.ts call them: the same skills, user messages, tools,
// lanes and token caps. A judge scores meaning. Nothing in this file matches a
// word or an enum. A cache miss in --cached-only fails the process (CI keeps
// the step soft until a recording exists). This file does not spend.
//
//   node evals/run-group-plan-rsvp-calendar-eval.mjs --estimate
//   node evals/run-group-plan-rsvp-calendar-eval.mjs --dry
//   node evals/run-group-plan-rsvp-calendar-eval.mjs --cached-only
//   node --env-file=../../.env evals/run-group-plan-rsvp-calendar-eval.mjs --live --max-usd <cap>
//
// --live also needs HALE_SPEND_LEDGER. Do not record on this change.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { READER_FIXTURES, VOICE_FIXTURES } from './group-plan-rsvp-calendar-fixtures.mjs';
import { noClient } from './lib/eval-flags.mjs';
import {
  JUDGE_MIN,
  PRICE,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  scoreFirstJudgeSchema,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const CALENDAR_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-plan-rsvp', 'calendar.ts');
const VOICE_SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-plan-rsvp', 'voice.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TAG = 'group-plan-rsvp-calendar';
const MODES = ['--estimate', '--dry', '--cached-only', '--live'];
const JUDGE_MAX_TOKENS = 440;
const JUDGE_REASON_MAX = 160;
const JUDGE_TOOL = scoreFirstJudgeSchema(JUDGE_REASON_MAX);

const READER_JUDGE = [
  'You score one reading of a private message about putting one plan on one household calendar.',
  'You are given the input the reader saw, the situation, and the reading (decision and confidence).',
  'decision is one of ok, decline, reopen, not_this. confidence is high or low.',
  'Score 1-5 on whether the reading matches the situation. Grade the meaning.',
  'A 5 is the decision the situation describes. Confidence is high only when the situation is clear enough to change the calendar ask.',
  'A low score treats a message about who is coming as a calendar answer, treats a laugh or a question tapback as a decision,',
  'agrees when they refused, refuses when they agreed, or reopens when they only said they are still coming.',
  'Do not require particular words. Reply with ONLY the score tool.',
].join(' ');

const VOICE_JUDGE = [
  'You score one private text Hale sends to one parent about their own calendar.',
  'You are given the input (kind, language, facts, questions) and the line. Score 1-5 on meaning.',
  'A 5 is one short bubble, in input.language, the way a friend texts. It uses only the facts it was given.',
  'calendar_ask asks once, about putting this plan on this household calendar. calendar_written says it is on their calendar and asks nothing.',
  'A low score is the wrong language, a second question, a question when questions is 0, an invented name or time or place,',
  'a claim about someone else or about seeing their other events, a link, a keyword to reply with, or a fixed template.',
  'Do not require particular words. Reply with ONLY the score tool.',
].join(' ');

function parseMode(argv) {
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-usd') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-usd=')) continue;
    rest.push(arg);
  }
  if (rest.length !== 1 || !MODES.includes(rest[0])) {
    throw new Error(`pass exactly one of ${MODES.join(' | ')} (--live also takes --max-usd)`);
  }
  return rest[0].slice(2);
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

function priced(model, input, output) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

function voiceUserMessage(calendar, fixture) {
  return JSON.stringify({
    ...calendar.groupPlanCalendarLineInput({
      kind: fixture.kind,
      language: fixture.language,
      parentWords: null,
      facts: fixture.facts,
    }),
    retry: false,
  });
}

async function loadSubjects() {
  const agent = await importTs(AGENT_SRC);
  const calendar = await importTs(CALENDAR_SRC);
  const voice = await importTs(VOICE_SRC);
  const readSkill = await agent.loadSkill(join(SKILLS, 'group-plan-rsvp-calendar-read.md'));
  const voiceSkill = await agent.loadSkill(join(SKILLS, 'group-plan-rsvp-calendar-voice.md'));
  return {
    agent,
    calendar,
    voice,
    readSkill,
    voiceSkill,
    readLane: agent.pickLane(readSkill.meta.task),
    voiceLane: agent.pickLane(voiceSkill.meta.task),
    judgeModel: await readJudgeModel(),
  };
}

function suiteUsd(subjects, { readerCalls, voiceCalls, judgeCalls }) {
  let usd = 0;
  const readTool = estimateTokens({
    name: subjects.calendar.CALENDAR_CONSENT_TOOL_NAME,
    description: subjects.calendar.CALENDAR_CONSENT_TOOL_DESCRIPTION,
    input_schema: subjects.calendar.CALENDAR_CONSENT_TOOL_SCHEMA,
  });
  const voiceTool = estimateTokens({
    name: subjects.voice.GROUP_PLAN_VOICE_TOOL_NAME,
    description: subjects.voice.GROUP_PLAN_VOICE_TOOL_DESCRIPTION,
    input_schema: subjects.voice.GROUP_PLAN_RSVP_VOICE_TOOL_SCHEMA,
  });
  const judgeTool = estimateTokens(JUDGE_TOOL);
  for (const fixture of READER_FIXTURES) {
    const user = subjects.calendar.calendarConsentUserMessage(fixture.input);
    const input = estimateTokens(subjects.readSkill.instructions) + estimateTokens(user) + readTool;
    usd +=
      priced(subjects.readLane.model, input, subjects.calendar.CALENDAR_CONSENT_MAX_TOKENS) *
      readerCalls;
    const judgeIn =
      estimateTokens(READER_JUDGE) +
      estimateTokens({ input: user, situation: fixture.situation, reading: {} }) +
      judgeTool +
      subjects.calendar.CALENDAR_CONSENT_MAX_TOKENS;
    usd += priced(subjects.judgeModel, judgeIn, JUDGE_MAX_TOKENS) * judgeCalls;
  }
  for (const fixture of VOICE_FIXTURES) {
    const user = voiceUserMessage(subjects.calendar, fixture);
    const input =
      estimateTokens(subjects.voiceSkill.instructions) + estimateTokens(user) + voiceTool;
    usd +=
      priced(subjects.voiceLane.model, input, subjects.voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS) *
      voiceCalls;
    const judgeIn =
      estimateTokens(VOICE_JUDGE) +
      estimateTokens({ input: user, situation: fixture.situation, line: '' }) +
      judgeTool +
      subjects.voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS;
    usd += priced(subjects.judgeModel, judgeIn, JUDGE_MAX_TOKENS) * judgeCalls;
  }
  return usd;
}

async function price(mode) {
  const subjects = await loadSubjects();
  const calls =
    mode === 'dry'
      ? { readerCalls: 4, voiceCalls: 2, judgeCalls: 1 }
      : { readerCalls: 1, voiceCalls: 1, judgeCalls: 1 };
  const usd = suiteUsd(subjects, calls);
  const note =
    mode === 'dry'
      ? 'worst case: reader retried twice with one re-ask each, voice retried once, judge once'
      : 'one subject call and one judge call per fixture, priced at max_tokens';
  console.info(
    `${TAG}: one estimate to record ${READER_FIXTURES.length} reader fixtures and ${VOICE_FIXTURES.length} voice fixtures (subject + judge), ${note}. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`,
  );
}

function liveGuard() {
  if (!process.env.HALE_SPEND_LEDGER || process.env.HALE_EVAL_LEDGER_DEFAULTED === '1') {
    console.error(`${TAG} eval: --live needs HALE_SPEND_LEDGER`);
    process.exit(2);
  }
  const cap = installEvalSpendCap();
  if (cap === null) {
    console.error(`${TAG} eval: --live needs --max-usd or HALE_MAX_USD`);
    process.exit(2);
  }
}

async function run(mode) {
  const cachedOnly = mode === 'cached-only';
  if (mode === 'live') liveGuard();
  const subjects = await loadSubjects();
  const getClient = mode === 'live' ? lazyAnthropic(TAG) : noClient(TAG);
  const cost = makeCost();
  const readerJudge = makeJudge(
    subjects.judgeModel,
    READER_JUDGE,
    `${TAG}-read`,
    cachedOnly,
    getClient,
    cost,
    { toolSchema: JUDGE_TOOL, keepTruncatedScore: true, maxTokens: JUDGE_MAX_TOKENS },
  );
  const voiceJudge = makeJudge(
    subjects.judgeModel,
    VOICE_JUDGE,
    `${TAG}-voice`,
    cachedOnly,
    getClient,
    cost,
    { toolSchema: JUDGE_TOOL, keepTruncatedScore: true, maxTokens: JUDGE_MAX_TOKENS },
  );
  console.info(
    `${TAG} eval | mode=${mode} | read=${subjects.readLane.model} voice=${subjects.voiceLane.model} judge=${subjects.judgeModel}`,
  );
  let failed = 0;
  for (const fixture of READER_FIXTURES) {
    const userMessage = subjects.calendar.calendarConsentUserMessage(fixture.input);
    const { value } = await cachedToolCall({
      tag: `${TAG}:read:${fixture.id}`,
      lane: subjects.readLane,
      system: subjects.readSkill.instructions,
      userMessage,
      toolName: subjects.calendar.CALENDAR_CONSENT_TOOL_NAME,
      toolDescription: subjects.calendar.CALENDAR_CONSENT_TOOL_DESCRIPTION,
      toolSchema: subjects.calendar.CALENDAR_CONSENT_TOOL_SCHEMA,
      maxTokens: subjects.calendar.CALENDAR_CONSENT_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const verdict = await readerJudge(fixture.id, {
      input: userMessage,
      situation: fixture.situation,
      reading: value,
    });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(`${ok ? 'PASS' : 'FAIL'}  read:${fixture.id}  judge:${verdict.score}`);
  }
  for (const fixture of VOICE_FIXTURES) {
    const userMessage = voiceUserMessage(subjects.calendar, fixture);
    const { value } = await cachedToolCall({
      tag: `${TAG}:voice:${fixture.id}`,
      lane: subjects.voiceLane,
      system: subjects.voiceSkill.instructions,
      userMessage,
      toolName: subjects.voice.GROUP_PLAN_VOICE_TOOL_NAME,
      toolDescription: subjects.voice.GROUP_PLAN_VOICE_TOOL_DESCRIPTION,
      toolSchema: subjects.voice.GROUP_PLAN_RSVP_VOICE_TOOL_SCHEMA,
      maxTokens: subjects.voice.GROUP_PLAN_RSVP_VOICE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const verdict = await voiceJudge(fixture.id, {
      input: userMessage,
      situation: fixture.situation,
      line: value,
    });
    const ok = verdict.score >= JUDGE_MIN;
    if (!ok) failed += 1;
    console.info(`${ok ? 'PASS' : 'FAIL'}  voice:${fixture.id}  judge:${verdict.score}`);
  }
  console.info(
    `${TAG} | ${mode} | failures=${failed} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failed > 0) process.exit(1);
}

async function main() {
  let mode;
  try {
    mode = parseMode(process.argv.slice(2));
  } catch (err) {
    console.error(`${TAG} eval: ${err instanceof Error ? err.message : 'bad flags'}`);
    process.exit(2);
  }
  if (mode === 'estimate' || mode === 'dry') {
    await price(mode);
    return;
  }
  await run(mode);
}

main().catch((err) => {
  console.error(`${TAG} eval harness error:`, err);
  process.exit(1);
});
