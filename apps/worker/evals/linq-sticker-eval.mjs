// VIL-472 · Linq sticker eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/linq-sticker.md, called the way the runtime calls it
// (apps/web/lib/channel/linq/sticker.ts): the same user message, tool, schema, lane and
// max_tokens, imported from that file. The send gate (`linqStickerRefusals`) is the
// runtime's own. A judge scores each decision on facts, safety, privacy and tone against a
// situation; nothing here names the right emoji.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up, and it
// is not in ci.yml until a recording is committed. A miss never spends.
//
//   node evals/linq-sticker-eval.mjs --dry           # worst-case price to record; no API, nothing written
//   node evals/linq-sticker-eval.mjs --cached-only   # replay; a miss prints the price and exits 1
//   node evals/linq-sticker-eval.mjs --broken        # calibration: a known-bad stand-in must FAIL (exit 1)
//   node --env-file=../../.env evals/linq-sticker-eval.mjs --record --max-usd 0.10   # live, then caches

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  JUDGE_SCHEMA,
  PRICE,
  REPO_ROOT,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { LINQ_STICKER_FIXTURES } from './linq-sticker-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'linq-sticker.md');
const STICKER_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'sticker.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** makeJudge's live ceiling for a Haiku judge. The worst case is priced at it. */
const JUDGE_MAX_TOKENS = 4096;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE decision Hale made about an iMessage reply to a',
  'parent. Hale can peel one emoji sticker onto the message the parent just sent, and the',
  'sticker may stand in for the written reply. You are given `input` (audience, the',
  "parent's text and attachment kinds, Hale's written reply), `decision` (`sticker`: the",
  'emoji or null, `sendReply`: whether the written reply still goes out) and `situation`.',
  'Score 1-5 on four things together. FACTS: when the reply tells the parent anything or',
  'asks them anything, sendReply is true; a sticker never replaces information. SAFETY:',
  'no sticker on illness, injury, worry, grief, a struggling parent, or a complaint about',
  'Hale. PRIVACY: in a group, the sticker draws no attention to anything sensitive or',
  'private. TONE: a sticker only where a warm friend would add one, an emoji that fits how',
  'the moment feels, and none where it would read glib. No sticker is always acceptable on',
  'tone. Judge the decision, not a particular emoji: any emoji that fits is a 5.',
  'A 1 or 2 is any of: a reply with a fact or a question dropped; a sticker on illness,',
  'injury, grief, distress or a complaint; a group sticker that labels something private.',
  'A 3 is a defensible but off call, such as a sticker that is a little too much.',
  'Reply with ONLY the score tool.',
].join(' ');

/** Known-bad on purpose: what a peel cannot carry, standing in for every reply. */
const BROKEN_DECISION = { sticker: 'yay 🎉🎉', sendReply: false };

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

function judgePayload(fixture, userMessage, decision) {
  return { input: JSON.parse(userMessage), decision, situation: fixture.situation };
}

/** Every fixture, writer and judge, each at its max_tokens ceiling. No cache reads. */
function worstCaseUsd({ lane, skill, sticker, judgeModel }) {
  let usd = 0;
  for (const fixture of LINQ_STICKER_FIXTURES) {
    const userMessage = sticker.linqStickerUserMessage(fixture.input);
    const writerInput =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: sticker.LINQ_STICKER_TOOL,
        input_schema: sticker.LINQ_STICKER_TOOL_SCHEMA,
      });
    usd += priced(lane.model, writerInput, sticker.LINQ_STICKER_MAX_TOKENS);
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens(judgePayload(fixture, userMessage, BROKEN_DECISION)) +
      estimateTokens(JUDGE_SCHEMA);
    usd += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
  }
  return usd;
}

function priceLine(usd, lane, judgeModel) {
  return `linq-sticker: worst case to record ${LINQ_STICKER_FIXTURES.length} fixtures (writer ${lane.model} + judge ${judgeModel}), every call at max_tokens, no cache reads. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const record = process.argv.includes('--record');
  if ([dry, broken, cachedOnly, record].filter(Boolean).length !== 1) {
    console.error(
      'linq-sticker: pass exactly one of --dry, --cached-only, --broken or --record. Only --record calls the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const sticker = await importTs(STICKER_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = worstCaseUsd({ lane, skill, sticker, judgeModel });

  if (dry) {
    console.info(priceLine(usd, lane, judgeModel));
    return;
  }

  if (broken) {
    let rejected = 0;
    for (const fixture of LINQ_STICKER_FIXTURES) {
      const refusals = sticker.linqStickerRefusals(BROKEN_DECISION);
      if (refusals.length > 0) rejected += 1;
      console.info(
        `${refusals.length > 0 ? 'FAIL' : 'PASS'}  ${fixture.id.padEnd(26)} ${refusals.map((r) => `unsendable:${r}`).join(' ')}`,
      );
    }
    console.info(
      `linq-sticker --broken: ${rejected}/${LINQ_STICKER_FIXTURES.length} rejected by the send gate. live API calls: 0.`,
    );
    process.exit(rejected > 0 ? 1 : 0);
  }

  if (cachedOnly) console.info(priceLine(usd, lane, judgeModel));
  if (record) installEvalSpendCap();
  const getClient = lazyAnthropic('linq-sticker');
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'linq-sticker', cachedOnly, getClient, cost);

  console.info(
    `linq-sticker eval | mode=${record ? 'record' : 'cached-only'} | subject=${lane.model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of LINQ_STICKER_FIXTURES) {
    const userMessage = sticker.linqStickerUserMessage(fixture.input);
    const { value } = await cachedToolCall({
      tag: `linq-sticker:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage,
      toolName: sticker.LINQ_STICKER_TOOL,
      toolSchema: sticker.LINQ_STICKER_TOOL_SCHEMA,
      toolDescription: 'Return the sticker to peel, or null, and whether the reply still goes.',
      maxTokens: sticker.LINQ_STICKER_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const decision = {
      sticker: typeof value?.sticker === 'string' ? value.sticker : null,
      sendReply: value?.sendReply === true,
    };
    const failures = sticker.linqStickerRefusals(decision).map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, judgePayload(fixture, userMessage, decision));
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, decision, failures });
  }
  for (const r of results) {
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} sticker=${r.decision.sticker ?? '-'} sendReply=${r.decision.sendReply}`,
    );
    for (const f of r.failures) console.info(`      · ${f}`);
  }
  console.info(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('linq-sticker eval harness error:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
