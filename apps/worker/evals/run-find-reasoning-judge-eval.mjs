// find-reasoning-judge eval (VIL-524).
//
// The judge reads a nearby-find draft and decides whether the whole reply is the coach's
// own reasoning. `yes` withholds the reply and fails the turn, so the parent hears nothing;
// `no` sends the draft exactly as written. Each fixture has one right answer, so it is
// scored on the verdict alone, with no second judge.
//
// One forced call per fixture, Haiku (`task: triage`). The request shape and the user
// message are imported from apps/web/lib/channel/coach/find-reasoning-judge.ts, so the eval
// cannot drift from production.
//
// Usage (from apps/worker):
//   node evals/run-find-reasoning-judge-eval.mjs --cached-only
//   node evals/run-find-reasoning-judge-eval.mjs --dry
//   HALE_SPEND_LEDGER=... node evals/run-find-reasoning-judge-eval.mjs --max-usd N
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  FIND_REASONING_JUDGE_FIXTURES,
  FOLLOWUP_PROCESS_JUDGE_FIXTURES,
} from './find-reasoning-judge-fixtures.mjs';
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

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'find-reasoning-judge.md');
const FOLLOWUP_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'followup-process-judge.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const JUDGE_SRC = join(WEB_ROOT, 'lib', 'channel', 'coach', 'find-reasoning-judge.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const judge = await importTs(JUDGE_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const tool = judge.FIND_REASONING_TOOL;

  installEvalSpendCap();
  const getClient = lazyAnthropic('find-reasoning-judge');
  const cost = makeCost();
  const failures = [];
  for (const fixture of FIND_REASONING_JUDGE_FIXTURES) {
    const call = await cachedToolCall({
      tag: `find-reasoning-judge:${tool.maxTokens}:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: judge.findReasoningUserMessage(fixture.draft),
      toolName: tool.name,
      toolDescription: tool.description,
      toolSchema: tool.schema,
      maxTokens: tool.maxTokens,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const withhold = call.value?.withhold;
    const ok = withhold === fixture.expect;
    if (!ok) failures.push(fixture.id);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  withhold=${withhold} (wanted ${fixture.expect})`,
    );
    if (!ok) console.info(`      reason: ${call.value?.reason ?? ''}`);
  }
  // The activity follow-up's judge (VIL-571): which sentences report the search. A `flag`
  // fixture passes only when a returned sentence carries the named fragment AND is copied
  // from the draft, so a judge that flags something else, or invents a quote, fails it.
  const followUpSkill = await agent.loadSkill(FOLLOWUP_SKILL);
  const followUpTool = judge.FOLLOWUP_PROCESS_TOOL;
  for (const fixture of FOLLOWUP_PROCESS_JUDGE_FIXTURES) {
    const call = await cachedToolCall({
      tag: `followup-process-judge:${followUpTool.maxTokens}:${fixture.id}`,
      lane: agent.pickLane(followUpSkill.meta.task),
      system: followUpSkill.instructions,
      userMessage: judge.findReasoningUserMessage(fixture.draft),
      toolName: followUpTool.name,
      toolDescription: followUpTool.description,
      toolSchema: followUpTool.schema,
      maxTokens: followUpTool.maxTokens,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    // Scored through the runtime's own verbatim rule, so an invented quote fails here as it
    // would leave the draft unsent in production.
    const named = call.value?.process_sentences;
    const gate = Array.isArray(named)
      ? judge.followUpProcessVerdict(fixture.draft, named)
      : { verdict: 'unjudged', reason: 'judge_failed' };
    const ok =
      fixture.expect === 'clean'
        ? gate.verdict === 'clean'
        : gate.verdict === 'reports_process' &&
          gate.sentences.some((s) => s.includes(fixture.flagged));
    if (!ok) failures.push(fixture.id);
    console.info(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  ${gate.verdict} (wanted ${fixture.expect})`,
    );
    if (!ok) console.info(`      reason: ${call.value?.reason ?? ''}`);
  }
  if (dry) {
    console.info(dryReportLine('find-reasoning-judge'));
    return;
  }
  console.info(
    `find-reasoning-judge | fixtures=${FIND_REASONING_JUDGE_FIXTURES.length + FOLLOWUP_PROCESS_JUDGE_FIXTURES.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
