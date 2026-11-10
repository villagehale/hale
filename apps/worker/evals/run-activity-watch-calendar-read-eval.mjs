// activity-watch-calendar-read eval (VIL-564).
//
// Before an activity watch looks again, the model reads whether the family's calendar
// already holds the watched activity. `held` closes the watch, so the output has an
// exactly right answer: scored through the same accept production uses, with no judge.
// The pass bar is in the fixtures file: a `held` fixture needs `held`; every other one
// passes on anything that keeps the watch open.
//
// One forced call per fixture, max 600 tokens, Sonnet (`task: classify`). The request
// shape, schema and accept are imported from apps/web/lib/channel/activity/
// calendar-check.ts, so the eval cannot drift from production.
//
// Usage (from apps/worker):
//   node evals/run-activity-watch-calendar-read-eval.mjs --preflight
//   node evals/run-activity-watch-calendar-read-eval.mjs --cached-only
//
// --cached-only exits on the first miss and writes nothing. Do not record from CI.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { ACTIVITY_WATCH_CALENDAR_READ_FIXTURES } from './activity-watch-calendar-read-fixtures.mjs';
import {
  REPO_ROOT,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  priceRates,
  totalUsd,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'activity-watch-calendar-read.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const CHECK_SRC = join(WEB_ROOT, 'lib', 'channel', 'activity', 'calendar-check.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Anything but `held` keeps the watch open, which is what a not-held fixture asks for. */
function passes(fixture, verdict) {
  return fixture.expect === 'held' ? verdict === 'held' : verdict !== null && verdict !== 'held';
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const preflight = process.argv.includes('--preflight');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const check = await importTs(CHECK_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = ACTIVITY_WATCH_CALENDAR_READ_FIXTURES;

  if (preflight) {
    const rates = priceRates(lane.model);
    let worst = 0;
    for (const fixture of fixtures) {
      const inputTokens = Math.ceil(
        (skill.instructions.length + check.watchCalendarUserMessage(fixture.input).length) / 4,
      );
      worst +=
        (inputTokens / 1e6) * rates.input + (check.WATCH_CALENDAR_MAX_TOKENS / 1e6) * rates.output;
    }
    console.info(
      `activity-watch-calendar-read preflight | fixtures=${fixtures.length} model=${lane.model} | worst $${worst.toFixed(4)} | judges=0`,
    );
    return;
  }

  installEvalSpendCap();
  const getClient = lazyAnthropic('activity-watch-calendar-read');
  const cost = makeCost();
  const failures = [];
  for (const fixture of fixtures) {
    const call = await cachedToolCall({
      tag: `activity-watch-calendar-read:${check.WATCH_CALENDAR_MAX_TOKENS}:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: check.watchCalendarUserMessage(fixture.input),
      toolName: check.WATCH_CALENDAR_TOOL_NAME,
      toolDescription: check.WATCH_CALENDAR_TOOL_DESCRIPTION,
      toolSchema: check.WATCH_CALENDAR_TOOL_SCHEMA,
      maxTokens: check.WATCH_CALENDAR_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const verdict = check.acceptWatchCalendarVerdict(call.value);
    const ok = passes(fixture, verdict);
    if (!ok) failures.push(fixture.id);
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  ${verdict} (wanted ${fixture.expect})`);
    console.info(`      reason: ${call.value?.reason ?? ''}`);
  }
  if (dry) {
    console.info(dryReportLine('activity-watch-calendar-read'));
    return;
  }
  console.info(
    `activity-watch-calendar-read | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
