// The email-alert notice eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/email-alert-notice.md, called the way the runtime calls
// it (apps/web/lib/integrations/email-alert-notice.ts): the REAL facts builder, the REAL
// code gate that runs before the writer (`quietBeforeWriting`), the `email_alert_notice`
// tool on the skill's lane, then the runtime's own reading of the answer
// (`readEmailAlertNotice`, which applies the structural refusals).
//
// Two checks, and nothing matches words:
//   - THE DECISION, in code: every fixture says whether anything may be sent. A text for
//     a 'silent' fixture, or silence for a 'send' fixture, fails.
//   - THE TEXT, by a judge, for 'send' fixtures whose decision passed: facts, privacy,
//     the one question, tone.
//
//   node evals/run-email-alert-notice-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-email-alert-notice-eval.mjs --cached-only      # replay only
//   node evals/run-email-alert-notice-eval.mjs --broken           # calibration: must FAIL
//   node evals/run-email-alert-notice-eval.mjs --dry              # worst-case price, no client
//
// --broken replays what main sent before this change: the code-built "<sender> sent
// something about <title>" line for every email, matched or not. It fails on the decision
// check alone, so it needs no model, no judge and no cache.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { EMAIL_ALERT_NOTICE_FIXTURES } from './email-alert-notice-fixtures.mjs';
import {
  JUDGE_MIN,
  PRICE,
  REPO_ROOT,
  cacheGet,
  evalRunTag,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { cachedLaneToolCall, laneToolCacheKey } from './lib/lane-tool-call.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'email-alert-notice.md');
const NOTICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'integrations', 'email-alert-notice.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** The judge's ceiling: makeJudge's default for a Haiku judge. */
const JUDGE_MAX_TOKENS = 4096;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends a parent about an email in their',
  'connected Gmail. A model wrote the whole text from the facts; nothing is added around it.',
  'You are given the facts (now; children; email with sender, subject, kind, title,',
  'namedChild, was, when, location; fromParentsOwnCalendar; alreadyOnCalendar; offer;',
  'otherHaleFamiliesGoing; private; language), the text and watchFor notes. Score 1-5 on',
  'FACTS, PRIVACY and TONE, not wording.',
  'A 5: says what the occasion is and what happened with only the facts given; every date and',
  'time is correct INCLUDING morning versus afternoon; nothing invented; one or two short,',
  'calm sentences, like a friend; ends on ONE question offering to add it exactly when `offer`',
  'is not null, and asks nothing when it is null; when `otherHaleFamiliesGoing` is a number,',
  'says that many other Hale families, never just "families"; when `private` is true, says only',
  'the generic category and that details were kept out, with no sender, time, place or subject.',
  'A LOW score (1-2) is any of: a wrong or ambiguous AM/PM, time, date or place; an invented',
  'detail; quoting the subject line, an order or confirmation number, an amount or a surname;',
  'a vague "sent something about" sentence; a question when `offer` is null or no question',
  'when it is not; offering to add something already on the calendar; a link, emoji,',
  'exclamation mark or "reply YES"; anything a private text must withhold.',
  'Reply with ONLY the score tool.',
].join(' ');

/** What main sent, for every email that reached it: the incident, as code. */
function brokenText(fixture, notice) {
  const sender = notice.senderLabel(fixture.args.from);
  const title = fixture.args.extraction.event.title;
  return sender === '' ? `Something about ${title}` : `${sender} sent something about ${title}.`;
}

function decisionFailures(fixture, sent) {
  if (fixture.expect === 'silent' && sent !== null) return ['sent when it must be silent'];
  if (fixture.expect === 'send' && sent === null) return ['silent when it must send'];
  return [];
}

// --- --dry: the worst case, every call a miss, output at max_tokens -----------------

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const rate = PRICE[model];
  if (!rate) throw new Error(`email-alert-notice --dry: no price for ${model}`);
  return (input * rate.input + output * rate.output) / 1_000_000;
}

async function dryRun({ agent, lane, skill, notice, judgeModel }) {
  const tool = {
    name: notice.EMAIL_ALERT_NOTICE_TOOL,
    description: notice.EMAIL_ALERT_NOTICE_TOOL_DESCRIPTION,
    input_schema: notice.EMAIL_ALERT_NOTICE_TOOL_SCHEMA,
  };
  const judgeTool = { name: 'score', description: 'Return the score.' };
  const longestText = 'x'.repeat(notice.EMAIL_ALERT_NOTICE_MAX_TOKENS * 4);
  let usd = 0;
  let writerCalls = 0;
  let judgeCalls = 0;
  let writerHits = 0;
  const lines = [];
  for (const fixture of EMAIL_ALERT_NOTICE_FIXTURES) {
    const quiet = notice.quietBeforeWriting(fixture.args.extraction);
    if (quiet !== null) {
      lines.push(`  ${fixture.id.padEnd(38)} code gate (${quiet})  $0.0000`);
      continue;
    }
    const facts = factsFor(notice, fixture);
    const userMessage = notice.emailAlertNoticeUserMessage(facts);
    const key = laneToolCacheKey({
      agent,
      lane,
      tag: evalRunTag(`email-alert-notice:${fixture.id}`),
      system: skill.instructions,
      userMessage,
      toolName: notice.EMAIL_ALERT_NOTICE_TOOL,
      toolSchema: notice.EMAIL_ALERT_NOTICE_TOOL_SCHEMA,
      maxTokens: notice.EMAIL_ALERT_NOTICE_MAX_TOKENS,
    });
    const hit = (await cacheGet(key)) !== undefined;
    let row = 0;
    if (hit) writerHits += 1;
    else {
      const input =
        estimateTokens(skill.instructions) + estimateTokens(userMessage) + estimateTokens(tool);
      row += priced(lane.model, input, notice.EMAIL_ALERT_NOTICE_MAX_TOKENS);
      writerCalls += 1;
    }
    if (fixture.expect === 'send') {
      const judgeInput =
        estimateTokens(JUDGE_SYSTEM) +
        estimateTokens({ facts, text: longestText, watchFor: fixture.watchFor }) +
        estimateTokens(judgeTool) +
        200;
      row += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
      judgeCalls += 1;
    }
    usd += row;
    lines.push(
      `  ${fixture.id.padEnd(38)} writer ${hit ? 'hit ' : 'miss'}${fixture.expect === 'send' ? ' + judge' : ''}  $${row.toFixed(4)}`,
    );
  }
  return [
    `email-alert-notice | --dry | every miss, output at max_tokens | writer=${lane.model} judge=${judgeModel} | fixtures=${EMAIL_ALERT_NOTICE_FIXTURES.length}`,
    ...lines,
    `writer cache: ${writerHits} hit | calls if run live: writer ${writerCalls}, judge ${judgeCalls}`,
    `writer output priced at ${notice.EMAIL_ALERT_NOTICE_MAX_TOKENS} tokens, judge at ${JUDGE_MAX_TOKENS}; input ≈ 4 Latin chars/token, other chars 1 token each.`,
    `live API calls: 0 | worst-case cost of a full live run: $${usd.toFixed(4)} USD`,
  ].join('\n');
}

function factsFor(notice, fixture) {
  const { now, ...rest } = fixture.args;
  return notice.emailAlertNoticeFacts({ ...rest, now: new Date(now) });
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = process.argv.includes('--dry');
  if (dry && (broken || cachedOnly)) {
    console.error('email-alert-notice: --dry runs alone');
    process.exit(2);
  }
  const agent = await importTs(AGENT_SRC);
  const notice = await importTs(NOTICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  if (dry) {
    console.info(await dryRun({ agent, lane, skill, notice, judgeModel }));
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('email-alert-notice');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'email-alert-notice',
    cachedOnly,
    getClient,
    cost,
  );

  console.info(
    `email-alert-notice | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | writer=${lane.model} judge=${judgeModel} | fixtures=${EMAIL_ALERT_NOTICE_FIXTURES.length}`,
  );
  const misses = [];
  const results = [];
  for (const fixture of EMAIL_ALERT_NOTICE_FIXTURES) {
    if (broken) {
      const sent = brokenText(fixture, notice);
      results.push({ fixture, sent, why: 'code-built', failures: decisionFailures(fixture, sent) });
      continue;
    }

    const quiet = notice.quietBeforeWriting(fixture.args.extraction);
    if (quiet !== null) {
      results.push({ fixture, sent: null, why: quiet, failures: decisionFailures(fixture, null) });
      continue;
    }

    const facts = factsFor(notice, fixture);
    const userMessage = notice.emailAlertNoticeUserMessage(facts);
    const call = await cachedLaneToolCall({
      agent,
      lane,
      tag: evalRunTag(`email-alert-notice:${fixture.id}`),
      system: skill.instructions,
      userMessage,
      toolName: notice.EMAIL_ALERT_NOTICE_TOOL,
      toolDescription: notice.EMAIL_ALERT_NOTICE_TOOL_DESCRIPTION,
      toolSchema: notice.EMAIL_ALERT_NOTICE_TOOL_SCHEMA,
      maxTokens: notice.EMAIL_ALERT_NOTICE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const answer = notice.emailAlertNoticeOutputSchema.safeParse(call.value);
    if (!answer.success) {
      results.push({ fixture, sent: null, why: 'malformed', failures: ['malformed answer'] });
      continue;
    }
    const read = notice.readEmailAlertNotice(answer.data, facts);
    if ('refused' in read) {
      results.push({
        fixture,
        sent: null,
        why: 'refused',
        failures: read.refused.map((r) => `unsendable:${r}`),
      });
      continue;
    }
    const sent = read.notice.send ? read.notice.text : null;
    const why = read.notice.send ? 'written' : read.notice.why;
    const failures = decisionFailures(fixture, sent);
    if (failures.length === 0 && sent !== null) {
      const verdict = await judge(fixture.id, { facts, text: sent, watchFor: fixture.watchFor });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, sent, why, failures });
  }

  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(38)} [${r.why}] ${r.sent === null ? '(nothing sent)' : `"${r.sent}"`}`,
    );
    for (const f of r.failures) console.info(`        · ${f}`);
  }
  if (misses.length > 0) {
    console.error(
      `cache miss in --cached-only mode for ${misses.length} writer call(s). Record live with --max-usd, then commit the cache:\n  ${misses.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  // Calibration: every silent fixture must catch the code-built line.
  const silent = results.filter((r) => r.fixture.expect === 'silent');
  const caught = silent.every((r) => r.failures.length > 0);
  console.info(
    `broken-mode calibration (every silent fixture must fail): ${caught ? 'PASS' : 'FAIL'} (${silent.filter((r) => r.failures.length > 0).length}/${silent.length} caught)`,
  );
  process.exit(caught ? 0 : 1);
}

main().catch((err) => {
  console.error('email-alert-notice eval harness error:', err);
  process.exit(2);
});
