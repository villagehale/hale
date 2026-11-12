// The mismatch read eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/signup-mismatch-read.md, called the way the runtime calls
// it (apps/web/lib/signup/plan/mismatch-reader.ts): the REAL user message, the schema on the
// skill's lane, and the REAL code check (`toMismatchReading`: a choice id must be a real
// one, and a waitlist id a waitlist choice). Objective: the exact verdict and choice id.
//
//   node evals/run-signup-mismatch-read-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-mismatch-read-eval.mjs --cached-only      # replay only
//   node evals/run-signup-mismatch-read-eval.mjs --dry              # price, no client

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
import { SIGNUP_MISMATCH_READ_FIXTURES } from './signup-mismatch-read-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-mismatch-read.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'mismatch-reader.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function matches(reading, expected) {
  if (Array.isArray(expected)) return expected.some((one) => matches(reading, one));
  if (expected === null) return reading === null;
  if (!reading || reading.verdict !== expected.verdict) return false;
  return expected.choiceId === undefined || reading.choiceId === expected.choiceId;
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const reader = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-mismatch-read');
  const cost = makeCost();
  const failures = [];
  for (const fixture of SIGNUP_MISMATCH_READ_FIXTURES) {
    const input = {
      text: fixture.text,
      askedStart: fixture.askedStart,
      choices: fixture.choices,
      ...(fixture.emailed ? { emailed: true } : {}),
    };
    const call = await cachedToolCall({
      tag: `signup-mismatch-read:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: reader.signupMismatchReadUserMessage(input),
      toolName: reader.SIGNUP_MISMATCH_READ_TOOL,
      toolDescription: reader.SIGNUP_MISMATCH_READ_TOOL_DESCRIPTION,
      toolSchema: reader.SIGNUP_MISMATCH_READ_TOOL_SCHEMA,
      maxTokens: reader.SIGNUP_MISMATCH_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const parsed = reader.signupMismatchReadSchema.safeParse(call.value);
    const reading = parsed.success ? reader.toMismatchReading(parsed.data, fixture.choices) : null;
    const ok = matches(reading, fixture.expect);
    if (!ok) failures.push(fixture.id);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(32)} ${JSON.stringify(reading)}${ok ? '' : ` wanted ${JSON.stringify(fixture.expect)}`}`,
    );
  }
  if (dry) {
    console.info(dryReportLine('signup-mismatch-read'));
    return;
  }
  console.info(
    `signup-mismatch-read | model=${lane.model} | fixtures=${SIGNUP_MISMATCH_READ_FIXTURES.length} | failures=${failures.length} | live calls: ${cost.liveCalls} | $${totalUsd(cost).toFixed(4)}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(
    'signup-mismatch-read eval harness error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(2);
});
