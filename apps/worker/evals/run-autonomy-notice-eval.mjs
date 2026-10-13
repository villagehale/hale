// VIL-131 · autonomy notice eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/autonomy-notice.md, called the way the runtime calls it
// (apps/web/lib/channel/autonomy/compose.ts): the `autonomy_notice` tool forced on the
// skill's lane, then the runtime's own structural check (readAutonomyNotice).
//
// The model picks the words. Nothing here matches a phrase. Tone — including that the
// parent can say stop, and that there is one ask — is the judge's grade.
//
//   ANTHROPIC_API_KEY=... node evals/run-autonomy-notice-eval.mjs
//   node evals/run-autonomy-notice-eval.mjs --cached-only

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { AUTONOMY_NOTICE_FIXTURES } from './autonomy-notice-fixtures.mjs';
import {
  JUDGE_MIN,
  REPO_ROOT,
  evalRunTag,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { cachedLaneToolCall } from './lib/lane-tool-call.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'autonomy-notice.md');
const TEXT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'autonomy', 'notice-text.ts');

// notice-text.ts imports through the web `~` alias. `tsImport()` does not read that
// tsconfig, so the eval died at load. One registration, as in the add-them-yourself
// and memory-writeback runners, resolves `~` before either module is imported.
register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale, a family planner that lives in',
  "the parent's messages, sends. You are given `context` — the occasion (`armed`, `rearmed`,",
  'or `acted`), the `actionType` token, `recentInbound` (the parent’s own texts), and',
  '`localeHint` — and the `text`. Score 1-5.',
  'Write your argument first, quoting the text, and only then the score.',
  'A 5 is one text in the language of `recentInbound` when those texts show one, otherwise',
  'the `localeHint`, and not a language the context never gave. It is in the first person and matches the occasion:',
  'armed or rearmed says this kind will be handled without asking from now on; acted says',
  'it was just done without asking. It says the parent can tell Hale to stop anytime. It',
  'asks for at most one thing. It reads like a friend who is also a parent texting: chill,',
  'casual, specific. It does not invent a recipient, a time, a price, a place, or a link.',
  'Do not grade word choice, length or punctuation for their own sake; the writer picks',
  'the words.',
  'A 1 or 2 is any of: the wrong occasion; a third-person "Hale" as the subject; more than',
  'one ask; a word the parent is told to reply with; a numbered list or a template; an',
  'invented fact.',
  'A 3 matches the occasion but reads like a notification or an assistant offering a service.',
  'Reply with ONLY the score tool.',
].join(' ');

function grade(written, verdict) {
  if ('skipped' in written) return [`writer skipped: ${written.skipped}`];
  if (!verdict || verdict.score < JUDGE_MIN) {
    return [`judge:${verdict ? verdict.score : 'missing'} (${verdict ? verdict.reason : ''})`];
  }
  return [];
}

async function main() {
  const cachedOnly = process.argv.includes('--cached-only');
  const agent = await importTs(AGENT_SRC);
  const text = await importTs(TEXT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const getClient = lazyAnthropic();
  const cost = makeCost();
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'autonomy-notice', cachedOnly, getClient, cost);

  console.info(
    `autonomy-notice | ${cachedOnly ? 'cached-only' : 'live'} | model=${lane.model} judge=${judgeModel} | fixtures=${AUTONOMY_NOTICE_FIXTURES.length}`,
  );
  const misses = [];
  let failed = 0;
  for (const fixture of AUTONOMY_NOTICE_FIXTURES) {
    const call = await cachedLaneToolCall({
      agent,
      lane,
      tag: evalRunTag(`autonomy-notice:${fixture.id}`),
      system: skill.instructions,
      userMessage: text.autonomyNoticeContext(fixture.context),
      toolName: text.AUTONOMY_NOTICE_TOOL,
      toolDescription: 'The one text Hale sends.',
      toolSchema: text.AUTONOMY_NOTICE_TOOL_SCHEMA,
      maxTokens: text.AUTONOMY_NOTICE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const written = text.readAutonomyNotice(call.value, fixture.context);
    const verdict =
      'message' in written
        ? await judge(fixture.id, { context: fixture.context, text: written.message })
        : null;
    const failures = grade(written, verdict);
    if (failures.length > 0) failed += 1;
    console.info(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    if ('message' in written) console.info(`        > ${written.message}`);
    for (const failure of failures) console.info(`        - ${failure}`);
  }
  if (misses.length > 0) {
    console.error(`autonomy-notice: ${misses.length} cache miss(es) in --cached-only`);
    for (const miss of misses) console.error(`  ${miss}`);
    process.exit(1);
  }
  const passed = AUTONOMY_NOTICE_FIXTURES.length - failed;
  console.info(
    `\n${passed}/${AUTONOMY_NOTICE_FIXTURES.length} passed | live API calls: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
