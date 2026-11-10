// The registration plan reply eval (VIL-558 step 2, hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/signup-plan-reply.md, called the way the runtime calls it
// (apps/web/lib/signup/plan/writer.ts): the REAL user message (`planReplyUserMessage`),
// the schema on the skill's lane, the REAL code gate (`planReplyViolations`: no link) and
// the writer's one retry with the violation note. A draft still violating after the retry
// is what the runtime does not send, and fails here.
//
// Two checks, and nothing matches words:
//   - THE GATE, in code: the model never writes a link; code appends the one link.
//   - THE TEXT, by a judge: only the facts, registered only when confirmed, the two-places
//     note on the offer and the approval, no retry promise, the right language and tone.
//
//   node evals/run-signup-plan-reply-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-plan-reply-eval.mjs --cached-only      # replay only
//   node evals/run-signup-plan-reply-eval.mjs --broken           # calibration: must catch all
//   node evals/run-signup-plan-reply-eval.mjs --dry              # price, no client

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  REPO_ROOT,
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
import {
  SIGNUP_PLAN_REPLY_BROKEN,
  SIGNUP_PLAN_REPLY_FIXTURES,
} from './signup-plan-reply-fixtures.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-plan-reply.md');
const WRITER_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'writer.ts');
const ATTEMPTS = 2;

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = judgePrompt('signup-plan-reply');

function fixtureFor(id) {
  const fixture = SIGNUP_PLAN_REPLY_FIXTURES.find((item) => item.id === id);
  if (!fixture) throw new Error(`signup-plan-reply: no fixture ${id}`);
  return fixture;
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const writer = await importTs(WRITER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-plan-reply');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'signup-plan-reply',
    cachedOnly,
    getClient,
    cost,
  );
  console.info(
    `signup-plan-reply | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | writer=${lane.model} judge=${judgeModel} | fixtures=${SIGNUP_PLAN_REPLY_FIXTURES.length}`,
  );

  if (broken) {
    let caught = true;
    for (const item of SIGNUP_PLAN_REPLY_BROKEN) {
      const fixture = fixtureFor(item.fixtureId);
      const violations = writer.planReplyViolations(item.text);
      if (violations.length > 0) {
        console.info(`CAUGHT  ${item.id.padEnd(30)} code gate (${violations.join('; ')})`);
        continue;
      }
      const verdict = await judge(`broken:${item.id}`, {
        facts: fixture.facts,
        text: item.text,
        watchFor: fixture.watchFor,
      });
      if (dry) continue;
      const failed = verdict.score < JUDGE_MIN;
      if (!failed) caught = false;
      console.info(
        `${failed ? 'CAUGHT' : 'MISSED'}  ${item.id.padEnd(30)} judge:${verdict.score} (${verdict.reason}) breaks: ${item.breaks}`,
      );
    }
    if (dry) {
      console.info(dryReportLine('signup-plan-reply --broken', [judge.plan]));
      return;
    }
    console.info(
      `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
    );
    console.info(`broken-mode calibration: ${caught ? 'PASS' : 'FAIL'}`);
    process.exit(caught ? 0 : 1);
  }

  const results = [];
  for (const fixture of SIGNUP_PLAN_REPLY_FIXTURES) {
    let violation = null;
    let text = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const call = await cachedToolCall({
        tag: `signup-plan-reply:${fixture.id}${violation ? ':retry' : ''}`,
        lane,
        system: skill.instructions,
        userMessage: writer.planReplyUserMessage(fixture.facts, violation),
        toolName: writer.SIGNUP_PLAN_REPLY_TOOL,
        toolDescription: writer.SIGNUP_PLAN_REPLY_TOOL_DESCRIPTION,
        toolSchema: writer.SIGNUP_PLAN_REPLY_TOOL_SCHEMA,
        maxTokens: writer.SIGNUP_PLAN_REPLY_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      const draft = writer.signupPlanReplySchema.safeParse(call.value);
      const sent = writer.planReplyText(draft.success ? draft.data.text : '');
      const violations = writer.planReplyViolations(sent);
      if (violations.length === 0) {
        text = sent;
        break;
      }
      violation = violations.join('; ');
    }
    const failures = [];
    if (text === null) failures.push(`unsendable after retry: ${violation}`);
    else {
      const verdict = await judge(fixture.id, {
        facts: fixture.facts,
        text,
        watchFor: fixture.watchFor,
      });
      if (!dry && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    results.push({ fixture, text, failures });
  }
  if (dry) {
    console.info(dryReportLine('signup-plan-reply', [judge.plan]));
    return;
  }
  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(32)} ${r.text === null ? '(nothing sent)' : `"${r.text}"`}`,
    );
    for (const f of r.failures) console.info(`        · ${f}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error('signup-plan-reply eval harness error:', err instanceof Error ? err.message : err);
  process.exit(2);
});
