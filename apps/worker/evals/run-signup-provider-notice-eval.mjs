// The registration notice eval, for a site whose options do not match (hard rule #8: no LLM
// mocking).
//
// SUBJECT: packages/agent/skills/signup-provider-notice.md, called the way the runtime calls
// it (apps/web/lib/signup/plan/notice-writer.ts): the REAL user message, the schema on the
// skill's lane, and the REAL bubble gate (`providerNoticeBubbles`: no link). A judge reads
// the facts, the billing notes and whether an email is offered only when Hale can draft it.
//
//   node evals/run-signup-provider-notice-eval.mjs --max-usd <cap>   # live, then caches
//   node evals/run-signup-provider-notice-eval.mjs --cached-only      # replay only
//   node evals/run-signup-provider-notice-eval.mjs --dry              # price, no client

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
import { judgePrompt } from './lib/judge-prompt.mjs';
import { SIGNUP_PROVIDER_NOTICE_FIXTURES } from './signup-provider-notice-fixtures.mjs';

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'signup-provider-notice.md');
const WRITER_SRC = join(WEB_ROOT, 'lib', 'signup', 'plan', 'notice-writer.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = judgePrompt('signup-provider-notice');

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const writer = await importTs(WRITER_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();

  installEvalSpendCap();
  const getClient = lazyAnthropic('signup-provider-notice');
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'signup-provider-notice',
    cachedOnly,
    getClient,
    cost,
  );
  console.info(
    `signup-provider-notice | ${cachedOnly ? 'cached-only' : 'live'} | writer=${lane.model} judge=${judgeModel} | fixtures=${SIGNUP_PROVIDER_NOTICE_FIXTURES.length}`,
  );

  const results = [];
  for (const fixture of SIGNUP_PROVIDER_NOTICE_FIXTURES) {
    const call = await cachedToolCall({
      tag: `signup-provider-notice:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: writer.providerNoticeUserMessage(fixture.facts),
      toolName: writer.SIGNUP_PROVIDER_NOTICE_TOOL,
      toolDescription: writer.SIGNUP_PROVIDER_NOTICE_TOOL_DESCRIPTION,
      toolSchema: writer.SIGNUP_PROVIDER_NOTICE_TOOL_SCHEMA,
      maxTokens: writer.SIGNUP_PROVIDER_NOTICE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const parsed = writer.signupProviderNoticeSchema.safeParse(call.value);
    const bubbles = parsed.success
      ? writer.providerNoticeBubbles(parsed.data.bubbles ?? parsed.data.text ?? null)
      : null;
    const failures = [];
    if (bubbles === null) failures.push('unsendable: no bubbles, or a bubble carries a link');
    else {
      const verdict = await judge(fixture.id, {
        facts: fixture.facts,
        bubbles,
        watchFor: fixture.watchFor,
      });
      if (!dry && verdict.score < JUDGE_MIN) {
        failures.push(`judge:${verdict.score} (${verdict.reason})`);
      }
    }
    results.push({ fixture, bubbles, failures });
  }
  if (dry) {
    console.info(dryReportLine('signup-provider-notice', [judge.plan]));
    return;
  }
  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(28)} ${r.bubbles === null ? '(nothing sent)' : JSON.stringify(r.bubbles)}`,
    );
    for (const f of r.failures) console.info(`        · ${f}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

main().catch((err) => {
  console.error(
    'signup-provider-notice eval harness error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(2);
});
