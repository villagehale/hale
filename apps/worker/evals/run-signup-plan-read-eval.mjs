// The day-before plan read eval (VIL-558 step 2, hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/signup-plan-read.md, called the way the runtime calls it
// (apps/web/lib/signup/plan/reader.ts): the REAL user message, the REAL strict schema on
// the skill's lane, and the REAL structural check and bindings (`toPlanReading`). An
// approval moves a family's money at the open, so the answer is exact: the verdict, for an
// approval the sessions in the parent's order, the maximum and the waiver answer, and
// `named` where a case sets it. A case whose `expect` is a list passes on any one of them;
// a null expectation is an unreadable reading (no plan). No judge.
//
//   node evals/run-signup-plan-read-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-plan-read-eval.mjs --cached-only      # replay only
//   node evals/run-signup-plan-read-eval.mjs --dry              # price, no client

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  REPO_ROOT,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { SIGNUP_PLAN_READ_FIXTURES } from './signup-plan-read-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-plan-read.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'reader.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function offerOf(fixture) {
  return { ...fixture.offer, opensAt: new Date(fixture.offer.opensAt) };
}

function matches(reading, expected) {
  if (Array.isArray(expected)) return expected.some((one) => matches(reading, one));
  if (expected === null) return reading === null;
  if (!reading || reading.verdict !== expected.verdict) return false;
  if (expected.named !== undefined && reading.named !== expected.named) return false;
  if (expected.verdict !== 'approve') return true;
  return (
    JSON.stringify(reading.choiceIds) === JSON.stringify(expected.choiceIds) &&
    reading.maxPriceCents === expected.maxPriceCents &&
    reading.waiverAccepted === expected.waiverAccepted
  );
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const reader = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-plan-read');
  const cost = makeCost();
  const failures = [];
  for (const fixture of SIGNUP_PLAN_READ_FIXTURES) {
    const offer = offerOf(fixture);
    const call = await cachedToolCall({
      tag: `signup-plan-read:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: reader.signupPlanReadUserMessage({ text: fixture.text, offer }),
      toolName: reader.SIGNUP_PLAN_READ_TOOL,
      toolDescription: reader.SIGNUP_PLAN_READ_TOOL_DESCRIPTION,
      toolSchema: reader.SIGNUP_PLAN_READ_TOOL_SCHEMA,
      maxTokens: reader.SIGNUP_PLAN_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const parsed = reader.signupPlanReadSchema.safeParse(call.value);
    const reading = parsed.success ? reader.toPlanReading(parsed.data, offer, fixture.text) : null;
    const ok = matches(reading, fixture.expect);
    if (!ok) failures.push(fixture.id);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(40)} ${JSON.stringify(reading)}${ok ? '' : ` wanted ${JSON.stringify(fixture.expect)}`}`,
    );
  }
  if (dry) {
    console.info(dryReportLine('signup-plan-read'));
    return;
  }
  console.info(
    `signup-plan-read | model=${lane.model} | fixtures=${SIGNUP_PLAN_READ_FIXTURES.length} | failures=${failures.length} | live calls: ${cost.liveCalls} | $${totalUsd(cost).toFixed(4)}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('signup-plan-read eval harness error:', err instanceof Error ? err.message : err);
  process.exit(2);
});
