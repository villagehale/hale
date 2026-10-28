// The group plan report · composer eval (VIL-443 T17, hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/group-plan-calendar-report.md) over
// the REAL facts, request and gates, all imported from
// apps/web/lib/channel/group-plan/report.ts, and the runtime's two attempts: the skill's
// lane, then the small lane told what the first draft got wrong. A judge scores facts and
// tone against the group-chat bar (VIL-399): says what changed, says whose calendars it
// reached and nobody else's, hands the link to whoever it is not on yet, never invents
// time, place, attendees or availability. Nothing matches words.
//
// NOT RECORDED YET. A recording is paid and needs Barton's OK with a price first, so this
// file is not named run-*.mjs: the Monday sweep replays every run-*.mjs cached-only and a
// miss fails it. Price it, record it, then rename it:
//   node evals/group-plan-calendar-report-eval.mjs --dry           # worst case $, 0 calls
//   node evals/group-plan-calendar-report-eval.mjs --broken        # calibration: must FAIL, 0 calls
//   node evals/group-plan-calendar-report-eval.mjs --max-usd 0.10  # live (HALE_SPEND_LEDGER), caches
//   node evals/group-plan-calendar-report-eval.mjs --cached-only   # replay; a miss exits 1
// `--broken --judge` also asks the judge about the broken text (live unless --cached-only).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  GROUP_PLAN_CALENDAR_REPORT_BROKEN,
  GROUP_PLAN_CALENDAR_REPORT_FIXTURES,
} from './group-plan-calendar-report-fixtures.mjs';
import {
  JUDGE_MIN,
  JUDGE_SCHEMA,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-plan-calendar-report.md');
const REPORT_SRC = join(WEB_ROOT, 'lib', 'channel', 'group-plan', 'report.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TAG = 'group-plan-calendar-report';

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends into a family group chat after a plan',
  'the group made was put on the household calendar, moved, or called off. Everyone in the chat',
  'reads it, including people who are not Hale customers. You are given the facts the writer was',
  'handed (input: change, event, onCalendarOf, notYet, othersNotYet, everyone, link, language),',
  'the text and watchFor notes. Score 1-5 on FACTS and BEHAVIOUR, not wording. A 5 says plainly',
  'what changed; uses only the event as given; says it is on the calendars of exactly the people',
  'in onCalendarOf and of nobody else; hands the link to the people it is not on yet, or to the',
  'whole group when onCalendarOf is empty; says everyone has it only when everyone is true; for a',
  'cancel, says it is off, with no link and no names; asks nothing of anyone, because the plan is',
  'made; is in input.language (French: vous to the group); first person; plain and short, the way',
  'a friend in the chat would say it. A LOW score is any of: saying it is on the calendar of',
  'someone not in onCalendarOf, or that everyone has it when everyone is false; a time, place,',
  'person, attendee, availability or next step that is not in the input; saying why someone does',
  'not have it; no link when one is given, or any link on a cancel; asking the group anything (a',
  'question, a vote, an RSVP, a confirmation, a reply with a word); the wrong language; system talk',
  'or hype; far more words than the facts need.',
  'Reply with ONLY the score tool.',
].join(' ');

// --- the --dry bound -------------------------------------------------------------

/** One structured request is at most two calls: the first and its one identical re-ask.
 * Both lanes here run with thinking off, so the thinking-off re-ask cannot fire. */
const CALLS_PER_REQUEST = 2;
/** What the API adds to a structured call's input, generously (tool-use prompt, framing). */
const PER_CALL_OVERHEAD_TOKENS = 500;
/** The judge's output ceiling for a Haiku judge (harness makeJudge). */
const JUDGE_MAX_TOKENS = 4096;
/** Every reason a draft can be refused, so the retry's turn is at its longest. */
const EVERY_REFUSAL = ['empty', 'carries_link', 'link_missing', 'link_repeated', 'other_link'];

/** Rounded up: a third of a token per Latin character, two for anything else. */
function tokensAtMost(text) {
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x250) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 3) + other * 2;
}

function addBound(bound, model, calls, input, output) {
  if (!bound.byModel[model]) bound.byModel[model] = { input: 0, output: 0 };
  bound.byModel[model].input += calls * input;
  bound.byModel[model].output += calls * output;
  bound.calls += calls;
}

// --- the run ---------------------------------------------------------------------

async function main() {
  const dry = process.argv.includes('--dry');
  const broken = process.argv.includes('--broken');
  const judgeBroken = process.argv.includes('--judge');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic(TAG);
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const report = await importTs(REPORT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lanes = [agent.pickLane(skill.meta.task), report.GROUP_PLAN_REPORT_RETRY_LANE];
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, TAG, cachedOnly, getClient, cost);
  const request = {
    system: skill.instructions,
    toolName: report.GROUP_PLAN_REPORT_TOOL,
    toolSchema: report.GROUP_PLAN_REPORT_TOOL_SCHEMA,
    toolDescription: report.GROUP_PLAN_REPORT_TOOL_DESCRIPTION,
    maxTokens: report.GROUP_PLAN_REPORT_MAX_TOKENS,
  };
  const mode = dry ? 'dry' : broken ? `broken${judgeBroken ? ' +judge' : ''}` : 'real';
  console.log(
    `${TAG} eval | mode=${mode}${cachedOnly ? ' (cached-only)' : ''} | compose=${lanes.map((l) => l.model).join(',')} judge=${judgeModel}`,
  );

  const facts = GROUP_PLAN_CALENDAR_REPORT_FIXTURES.map((fixture) => {
    const input = report.groupPlanReportInput(fixture.args);
    if (!input) throw new Error(`fixture ${fixture.id} produced no report input`);
    return { fixture, input, userMessage: report.groupPlanReportUserMessage(input) };
  });

  if (dry) {
    const toolTokens = (name, description, schema) =>
      tokensAtMost(`${name}${description}${JSON.stringify(schema)}`);
    const composeTool = toolTokens(request.toolName, request.toolDescription, request.toolSchema);
    const judgeTool = toolTokens('score', 'Return the score.', JUDGE_SCHEMA);
    const suite = { byModel: {}, calls: 0 };
    const brokenJudge = { byModel: {}, calls: 0 };
    let oneReport = { byModel: {}, calls: 0 };
    for (const { fixture, input, userMessage } of facts) {
      const turns = [userMessage, report.groupPlanReportUserMessage(input, EVERY_REFUSAL)];
      const thisReport = { byModel: {}, calls: 0 };
      for (const [index, lane] of lanes.entries()) {
        const sent = tokensAtMost(request.system) + tokensAtMost(turns[index]) + composeTool;
        for (const bound of [suite, thisReport]) {
          addBound(
            bound,
            lane.model,
            CALLS_PER_REQUEST,
            sent + PER_CALL_OVERHEAD_TOKENS,
            request.maxTokens,
          );
        }
      }
      if (totalUsd(thisReport) > totalUsd(oneReport)) oneReport = thisReport;
      const judged = (text) =>
        tokensAtMost(JUDGE_SYSTEM) +
        tokensAtMost(JSON.stringify({ input: userMessage, text, watchFor: fixture.watchFor })) +
        judgeTool +
        PER_CALL_OVERHEAD_TOKENS;
      // The text is the draft, at most its own ceiling, counted twice for JSON escaping.
      const draftCeiling = judged('') + 2 * request.maxTokens;
      addBound(suite, judgeModel, CALLS_PER_REQUEST, draftCeiling, JUDGE_MAX_TOKENS);
      addBound(
        brokenJudge,
        judgeModel,
        CALLS_PER_REQUEST,
        judged(GROUP_PLAN_CALENDAR_REPORT_BROKEN.text),
        JUDGE_MAX_TOKENS,
      );
    }
    const tokens = (bound) =>
      Object.values(bound.byModel).reduce(
        (sum, b) => ({ input: sum.input + b.input, output: sum.output + b.output }),
        { input: 0, output: 0 },
      );
    const s = tokens(suite);
    console.log(
      `worst case for one recording: ${facts.length} fixtures x (${lanes.length} drafts + 1 verdict) x ${CALLS_PER_REQUEST} calls = ${suite.calls} calls, ${s.input} in + ${s.output} out tokens at list price = $${totalUsd(suite).toFixed(4)} USD`,
    );
    console.log(
      `  assumes every first draft is refused, every request is re-asked once, every call writes to its ceiling (${request.maxTokens} per draft, ${JUDGE_MAX_TOKENS} per verdict)`,
    );
    console.log(
      `the judge's half of --broken, if recorded with it: ${brokenJudge.calls} calls = $${totalUsd(brokenJudge).toFixed(4)} USD`,
    );
    console.log(
      `one group text in production (no judge), worst fixture: ${oneReport.calls} calls = $${totalUsd(oneReport).toFixed(4)} USD`,
    );
    console.log(`live API calls this run: ${cost.liveCalls} | nothing written`);
    process.exit(0);
  }

  const results = [];
  for (const { fixture, input, userMessage } of facts) {
    const failures = [];
    let body = '';
    let drafts = 0;
    if (broken) {
      body = GROUP_PLAN_CALENDAR_REPORT_BROKEN.text;
      failures.push(...report.groupPlanReportRefusals(body, input).map((r) => `unsendable:${r}`));
    } else {
      // The runtime's own loop: a refused or failed first draft gets the small lane, told
      // what was wrong; when neither draft is accepted, nothing is sent.
      let refused = [];
      let accepted = false;
      for (const [index, lane] of lanes.entries()) {
        drafts += 1;
        try {
          const { value } = await cachedToolCall({
            ...request,
            tag: index === 0 ? `${TAG}:${fixture.id}` : `${TAG}:${fixture.id}:retry`,
            lane,
            userMessage: report.groupPlanReportUserMessage(input, refused),
            cachedOnly,
            getClient,
            cost,
          });
          body = String(value.text ?? '').trim();
          refused = report.groupPlanReportRefusals(body, input);
          if (refused.length === 0) {
            accepted = true;
            break;
          }
        } catch (err) {
          // Only what the model did is a failed draft (truncated, refused, no answer). A
          // spend cap, a network error or a harness fault stops the run.
          if (!err?.outcome) throw err;
          console.warn(`${fixture.id}: draft ${index + 1} failed (${err.outcome})`);
        }
      }
      if (!accepted) {
        failures.push(...refused.map((r) => `unsendable:${r}`), 'unsent:no draft was accepted');
      }
    }
    const judged = !broken || judgeBroken;
    if (judged && failures.every((f) => !f.startsWith('unsent:'))) {
      const verdict = await judge(fixture.id, {
        input: userMessage,
        text: body,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, body, drafts, failures });
  }
  for (const r of results) {
    const second = r.drafts > 1 ? ' [second draft]' : '';
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(24)} "${r.body}"${second}`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  if (broken && !judgeBroken) console.log('judge: not asked (add --judge for its half)');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const everyFixtureFailed = results.every((r) => r.failures.length > 0);
  console.log(
    `broken-mode calibration (must fail every fixture): ${everyFixtureFailed ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(everyFixtureFailed ? 0 : 1);
}

main().catch((err) => {
  console.error(`${TAG} eval harness error:`, err);
  process.exit(2);
});
