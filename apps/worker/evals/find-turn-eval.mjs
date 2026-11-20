// Find-turn reader eval (VIL-567, hard rule #8: no LLM mocking).
//
// Before composing find-private / find-day, the model reads whether this inbound is a
// nearby-find, in any language. `find` appends those addenda; `not_find` does not, so a
// calendar edit is never treated as a search. Scored through the same parse production
// uses (`toFindTurnReading`), with no second judge.
//
// One forced call per fixture, max 128 tokens, Haiku (`task: screen`). The request
// shape, schema and parse are imported from apps/web/lib/channel/coach/find-private.ts,
// so the eval cannot drift from production.
//
// CI replays it from the committed recordings (`eval:find-turn` in ci.yml).
//
// Usage (from apps/worker):
//   node evals/find-turn-eval.mjs --dry
//   node evals/find-turn-eval.mjs --cached-only
//   HALE_SPEND_LEDGER=... node evals/find-turn-eval.mjs --live --max-usd N

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { FIND_TURN_FIXTURES } from './find-turn-fixtures.mjs';
import {
  REPO_ROOT,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'coach-find-turn.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const READ_SRC = join(WEB_ROOT, 'lib', 'channel', 'coach', 'find-private.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

assertRunFlags(['--env-file', '--max-usd']);

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  const agent = await importTs(AGENT_SRC);
  const read = await importTs(READ_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = FIND_TURN_FIXTURES;

  installEvalSpendCap();
  const getClient = lazyAnthropic('find-turn');
  const cost = makeCost();
  const failures = [];
  for (const fixture of fixtures) {
    const call = await cachedToolCall({
      tag: `find-turn:${read.FIND_TURN_MAX_TOKENS}:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage: read.findTurnUserMessage(fixture.text, fixture.transcript),
      toolName: read.FIND_TURN_TOOL,
      toolDescription: read.FIND_TURN_TOOL_DESCRIPTION,
      toolSchema: read.FIND_TURN_TOOL_SCHEMA,
      maxTokens: read.FIND_TURN_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (dry) continue;
    const reading = read.toFindTurnReading(call.value);
    const intent = reading.findTurn ? 'find' : 'not_find';
    const ok = intent === fixture.expect;
    if (!ok) failures.push(fixture.id);
    console.info(`${ok ? 'PASS' : 'FAIL'}  ${fixture.id}  ${intent} (wanted ${fixture.expect})`);
    if (!ok) console.info(`      reason: ${call.value?.reason ?? ''}`);
  }
  if (dry) {
    console.info(dryReportLine('find-turn'));
    return;
  }
  console.info(
    `find-turn | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
