// workstream-extract eval (VIL-419 extraction; VIL-681 reads its label).
//
// After a reply turn the model returns workstream ops. The next-day check-back fires only
// on a thread left `waiting_on_parent`, so the label is graded objectively: the op and
// status each fixture's pass bar names, with no judge. The request shape, tool schema and
// parse are imported from apps/web/lib/memory/workstream-extract.ts, so the eval cannot
// drift from production.
//
// Usage (from apps/worker):
//   node evals/run-workstream-extract-eval.mjs --cached-only

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { WORKSTREAM_EXTRACT_FIXTURES } from './workstream-extract-fixtures.mjs';

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'extract-workstream.md');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const EXTRACT_SRC = join(WEB_ROOT, 'lib', 'memory', 'workstream-extract.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Each failure names what the fixture's bar asked for and what came back. */
function grade(fixture, ops) {
  const want = fixture.expect;
  const live = ops.filter((op) => op.action !== 'none');
  if (want.waitingOnParent) {
    const hit = live.some(
      (op) => (op.action === 'open' || op.action === 'update') && op.status === 'waiting_on_parent',
    );
    return hit ? [] : ['no open or update op left the thread waiting_on_parent'];
  }
  if (want.finished) {
    const mine = live.filter((op) => op.id === want.finished);
    const done = mine.some((op) => op.action === 'close' || op.status === 'scheduled');
    const still = mine.some((op) => op.status === 'waiting_on_parent' && op.action !== 'close');
    if (!done) return ['the booked thread was neither closed nor scheduled'];
    return still ? ['the booked thread was also left waiting_on_parent'] : [];
  }
  if (want.declined) {
    const mine = live.filter((op) => op.id === want.declined);
    return mine.some((op) => op.action === 'drop' || op.declined === true)
      ? []
      : ['the declined thread was not dropped or marked declined'];
  }
  if (want.none) return live.length === 0 ? [] : [`expected none, got ${live.length} op(s)`];
  if (want.childId) {
    return live.some((op) => op.childIds.includes(want.childId))
      ? []
      : ["no op carried the teen's child id"];
  }
  if (want.checkBack) {
    return live.some((op) => typeof op.checkBackAt === 'string' && op.checkBackAt.length > 0)
      ? []
      : ['no op set a check-back'];
  }
  throw new Error(`fixture ${fixture.id} has no pass bar`);
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await importTs(AGENT_SRC);
  const extract = await importTs(EXTRACT_SRC);
  const skill = await agent.loadSkill(SKILL);
  const lane = agent.pickLane(skill.meta.task);
  const fixtures = WORKSTREAM_EXTRACT_FIXTURES;

  installEvalSpendCap();
  const getClient = lazyAnthropic('workstream-extract');
  const cost = makeCost();
  const failures = [];
  console.info(
    `workstream-extract | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} | fixtures=${fixtures.length}`,
  );
  for (const fixture of fixtures) {
    const userMessage = extract.renderWorkstreamExtractInput({
      ...fixture.input,
      now: new Date(fixture.input.now),
    });
    const call = await cachedToolCall({
      tag: `workstream-extract:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage,
      toolName: extract.WORKSTREAM_TOOL_NAME,
      toolDescription: extract.WORKSTREAM_TOOL_DESCRIPTION,
      toolSchema: extract.workstreamToolJsonSchema,
      maxTokens: extract.WORKSTREAM_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const parsed = extract.workstreamExtractionSchema.safeParse(call.value);
    const problems = parsed.success ? grade(fixture, parsed.data.ops) : ['ops did not parse'];
    if (problems.length > 0) failures.push(fixture.id);
    console.info(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    for (const problem of problems) console.info(`        - ${problem}`);
    console.info(`      ops: ${JSON.stringify(call.value?.ops ?? null)}`);
  }
  console.info(
    `workstream-extract | fixtures=${fixtures.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
