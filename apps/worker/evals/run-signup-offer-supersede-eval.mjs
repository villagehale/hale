// Whether a new sign-up ask replaces an earlier one · eval (VIL-682, hard rule #8: no LLM
// mocking).
//
// SUBJECT: packages/agent/skills/signup-offer-supersede.md, called the way the runtime calls
// it (apps/web/lib/signup/supersede-reader.ts): the REAL user message, the REAL strict
// schema on the skill's lane, and the REAL check (`toSupersedeReading`: shown asks only,
// each dropped in words the parent wrote). A replaced ask is closed, so the answer is
// exact: the set of asks replaced. No judge.
//
//   node evals/run-signup-offer-supersede-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-offer-supersede-eval.mjs --cached-only      # replay only
//   node evals/run-signup-offer-supersede-eval.mjs --dry              # price, no client

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
import { SIGNUP_OFFER_SUPERSEDE_FIXTURES } from './signup-offer-supersede-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-offer-supersede.md');
const READER_SRC = join(WEB_ROOT, 'lib', 'signup', 'supersede-reader.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

function sameSet(got, want) {
  return got !== null && JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const reader = await importTs(READER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-offer-supersede');
  const cost = makeCost();
  const failures = [];
  for (const fixture of SIGNUP_OFFER_SUPERSEDE_FIXTURES) {
    const input = { text: fixture.text, next: fixture.next, earlier: fixture.earlier };
    const call = await cachedToolCall({
      tag: `signup-offer-supersede:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: reader.signupSupersedeReadUserMessage(input),
      toolName: reader.SIGNUP_SUPERSEDE_READ_TOOL,
      toolDescription: reader.SIGNUP_SUPERSEDE_READ_TOOL_DESCRIPTION,
      toolSchema: reader.SIGNUP_SUPERSEDE_READ_TOOL_SCHEMA,
      maxTokens: reader.SIGNUP_SUPERSEDE_READ_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const parsed = reader.signupSupersedeReadSchema.safeParse(call.value);
    const replaced = parsed.success
      ? reader.toSupersedeReading(parsed.data, fixture.earlier, fixture.text)
      : null;
    const ok = sameSet(replaced, fixture.expect);
    if (!ok) failures.push(fixture.id);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.id.padEnd(32)} ${JSON.stringify(replaced)}${ok ? '' : ` wanted ${JSON.stringify(fixture.expect)}`}`,
    );
  }
  if (dry) {
    console.info(dryReportLine('signup-offer-supersede'));
    return;
  }
  console.info(
    `signup-offer-supersede | model=${lane.model} | fixtures=${SIGNUP_OFFER_SUPERSEDE_FIXTURES.length} | failures=${failures.length} | live calls: ${cost.liveCalls} | $${totalUsd(cost).toFixed(4)}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(
    'signup-offer-supersede eval harness error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(2);
});
