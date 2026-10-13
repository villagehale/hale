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
//   node evals/run-autonomy-notice-eval.mjs --estimate   (no client, no API key, no spend)

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { AUTONOMY_NOTICE_FIXTURES } from './autonomy-notice-fixtures.mjs';
import {
  JUDGE_MIN,
  PRICE,
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
  'or `acted`), the `actionType` token, `recentInbound` (the parent’s own texts),',
  '`localeHint`, `standing`, and sometimes `detail` — and the `text`. Score 1-5.',
  'Write your argument first, quoting the text, and only then the score.',
  'A 5 is one text in the language of `recentInbound` when those texts show one, otherwise',
  'the `localeHint`, and not a language the context never gave. It is in the first person and matches the occasion:',
  'armed or rearmed says this kind will be handled without asking from now on; acted says',
  'it was just done without asking. It asks for at most one thing. It reads like a friend',
  'who is also a parent texting: chill, casual, specific. It does not invent a recipient,',
  'a time, a price, a place, or a link beyond `detail`.',
  'Grade `standing` as facts, not as phrases. The writer chooses the words. A missing fact',
  'keeps the score at 3 or below:',
  '`standing.never` lists book, register, and pay — the text conveys that the sender does',
  'not book, does not register, and does not pay.',
  'When `standing.repliesToEmail` is true, the text conveys that the sender will reply to',
  "email on the parent's behalf. When it is false, do not require that fact.",
  '`standing.stop` is `one_message` — the text conveys that one message from the parent',
  'turns this off.',
  'Do not grade word choice, length or punctuation for their own sake.',
  'A 1 or 2 is any of: the wrong occasion; a third-person "Hale" as the subject; more than',
  'one ask; a word the parent is told to reply with; a numbered list or a template; an',
  'invented fact.',
  'A 3 matches the occasion and the voice but is missing a standing fact, or reads like a',
  'notification or an assistant offering a service.',
  'Reply with ONLY the score tool.',
].join(' ');

// A re-record prices the tokens a short text and a short argument actually use.
// The writer cap (400) and the judge cap (4096) are ceilings, not the bill.
const ESTIMATE_WRITER_OUTPUT_TOKENS = 120;
const ESTIMATE_JUDGE_OUTPUT_TOKENS = 280;

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x024f) latin += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4) + other;
}

function priced(model, input, output) {
  const price = PRICE[model];
  if (!price) throw new Error(`no list price for ${model}`);
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}

function estimateRecording({ lane, skill, text, judgeModel }) {
  const writerTool = JSON.stringify({
    name: text.AUTONOMY_NOTICE_TOOL,
    description: 'The one text Hale sends.',
    input_schema: text.AUTONOMY_NOTICE_TOOL_SCHEMA,
  });
  const judgeTool = JSON.stringify({
    name: 'score',
    description: 'Return the score.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        score: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['reason', 'score'],
    },
  });
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const fixture of AUTONOMY_NOTICE_FIXTURES) {
    const contextJson = text.autonomyNoticeContext(fixture.context);
    const writerInput =
      estimateTokens(skill.instructions) + estimateTokens(contextJson) + estimateTokens(writerTool);
    const judgeUser = JSON.stringify({ context: JSON.parse(contextJson), text: '' });
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens(judgeUser) +
      estimateTokens(judgeTool) +
      ESTIMATE_WRITER_OUTPUT_TOKENS;
    inputTokens += writerInput + judgeInput;
    outputTokens += ESTIMATE_WRITER_OUTPUT_TOKENS + ESTIMATE_JUDGE_OUTPUT_TOKENS;
    usd += priced(lane.model, writerInput, ESTIMATE_WRITER_OUTPUT_TOKENS);
    usd += priced(judgeModel, judgeInput, ESTIMATE_JUDGE_OUTPUT_TOKENS);
  }
  const calls = AUTONOMY_NOTICE_FIXTURES.length * 2;
  return [
    `autonomy-notice | estimate | model=${lane.model} judge=${judgeModel} | fixtures=${AUTONOMY_NOTICE_FIXTURES.length}`,
    `calls=${calls} (every fixture is a miss: writer and judge both) | input tokens≈${inputTokens} | output tokens≈${outputTokens}`,
    'tokenizer: Latin and whitespace ≈ 4 chars/token; every other character ≈ 1 token.',
    `output assumption: writer ${ESTIMATE_WRITER_OUTPUT_TOKENS} tokens, judge ${ESTIMATE_JUDGE_OUTPUT_TOKENS} tokens. Caps of 400 and 4096 are not billed.`,
    `live API calls: 0 | estimated cost: $${usd.toFixed(4)} USD`,
  ].join('\n');
}

function maxUsdFlag() {
  const flag = process.argv.find((arg) => arg.startsWith('--max-usd='));
  if (!flag) return null;
  const value = Number(flag.slice('--max-usd='.length));
  if (!Number.isFinite(value) || value <= 0) {
    console.error('autonomy-notice: --max-usd needs a positive number of dollars');
    process.exit(1);
  }
  return value;
}

/** Refuse another live call once actual list-price spend is already at the cap. */
function spendGate(getClient, cost, maxUsd) {
  if (maxUsd == null) return getClient;
  return () => {
    const client = getClient();
    return {
      messages: {
        create: async (params) => {
          const spent = totalUsd(cost);
          if (spent >= maxUsd) {
            const error = new Error(
              `abort before API call: actual spend $${spent.toFixed(4)} is at the $${maxUsd.toFixed(4)} cap`,
            );
            error.code = 'SPEND_CAP';
            throw error;
          }
          return client.messages.create(params);
        },
      },
    };
  };
}

function grade(written, verdict) {
  if ('skipped' in written) return [`writer skipped: ${written.skipped}`];
  if (!verdict || verdict.score < JUDGE_MIN) {
    return [`judge:${verdict ? verdict.score : 'missing'} (${verdict ? verdict.reason : ''})`];
  }
  return [];
}

async function main() {
  const estimateOnly = process.argv.includes('--estimate');
  const cachedOnly = process.argv.includes('--cached-only');
  if (estimateOnly && cachedOnly) {
    console.error('autonomy-notice: pass only one of --estimate and --cached-only');
    process.exit(1);
  }
  const agent = await importTs(AGENT_SRC);
  const text = await importTs(TEXT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  if (estimateOnly) {
    const judgeModel = await readJudgeModel();
    console.info(estimateRecording({ lane, skill, text, judgeModel }));
    return;
  }
  const maxUsd = maxUsdFlag();
  const cost = makeCost();
  const gated = spendGate(lazyAnthropic(), cost, maxUsd);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'autonomy-notice', cachedOnly, gated, cost);

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
      getClient: gated,
      cost,
    });
    if (call.miss) {
      misses.push(`${fixture.id}  ${call.key}`);
      continue;
    }
    const writerContext = text.autonomyNoticeContext(fixture.context);
    const written = text.readAutonomyNotice(call.value, fixture.context);
    const verdict =
      'message' in written
        ? await judge(fixture.id, {
            context: JSON.parse(writerContext),
            text: written.message,
          })
        : null;
    const failures = grade(written, verdict);
    if (failures.length > 0) failed += 1;
    console.info(`${failures.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}`);
    if ('message' in written) console.info(`        > ${written.message}`);
    for (const failure of failures) console.info(`        - ${failure}`);
    if (maxUsd != null) {
      const spent = totalUsd(cost);
      console.info(`        spend so far $${spent.toFixed(4)} / $${maxUsd.toFixed(4)}`);
      if (spent > maxUsd) {
        console.error(
          `autonomy-notice: abort, actual spend $${spent.toFixed(4)} exceeds $${maxUsd.toFixed(4)}. No further calls.`,
        );
        process.exit(2);
      }
    }
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
  if (err && err.code === 'SPEND_CAP') {
    console.error(`autonomy-notice: ${err.message}`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : 'autonomy-notice failed');
  process.exit(1);
});
