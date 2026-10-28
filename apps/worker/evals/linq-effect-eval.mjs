// VIL-473 · Linq message-effect eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/linq-effect.md, called the way the runtime calls it
// (apps/web/lib/channel/linq/effect.ts): the same user message, tool, schema, lane and
// max_tokens, imported from that file. The send gate (`linqEffectRefusals`) is the
// runtime's own. A judge scores each decision on facts, safety, privacy and tone against a
// situation; nothing here names the right effect.
//
// This file is not named run-*.mjs, so the Monday eval sweep does not pick it up, and it
// is not in ci.yml until a recording is committed. A miss never spends.
//
//   node evals/linq-effect-eval.mjs --dry           # worst-case price to record; no API, nothing written
//   node evals/linq-effect-eval.mjs --cached-only   # replay; a miss prints the price and exits 1
//   node evals/linq-effect-eval.mjs --broken        # calibration: a known-bad stand-in must FAIL (exit 1)
//   node --env-file=../../.env evals/linq-effect-eval.mjs --record --max-usd 0.10   # live, then caches

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
import { LINQ_EFFECT_FIXTURES } from './linq-effect-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'linq-effect.md');
const EFFECT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'effect.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** makeJudge's live ceiling for a Haiku judge. The worst case is priced at it. */
const JUDGE_MAX_TOKENS = 4096;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE decision Hale made about an iMessage reply to a',
  'parent. Hale can send that written reply with a screen or bubble effect. You are given',
  "`input` (audience, the parent's text, Hale's written reply), `decision` (`effect`: the",
  'screen or bubble object or null) and `situation`.',
  'Score 1-5 on four things together. FACTS: an effect only when the facts are a rare',
  'celebration (a signup confirmed, a plan everyone said yes to, a birthday); never on a',
  'waitlist, a miss, or an ordinary question. SAFETY: no effect on illness, injury, worry,',
  'grief, a struggling parent, or a complaint about Hale. PRIVACY: in a group, the effect',
  'draws no attention to anything sensitive or private. TONE: an effect only where a warm',
  'friend would add one, and none where it would read glib. No effect is always acceptable',
  'on tone. Judge the decision, not a particular effect name: any listed name that fits is',
  'a 5.',
  'A 1 or 2 is any of: an effect on a waitlist, a miss, or a plain question; an effect on',
  'illness, injury, grief, distress or a complaint; a group effect that labels something',
  'private.',
  'A 3 is a defensible but off call, such as an effect that is a little too much.',
  'Reply with ONLY the score tool.',
].join(' ');

/** Known-bad on purpose: what a send cannot carry, standing in for every reply. */
const BROKEN_DECISION = { effect: { type: 'screen', name: 'yay' } };

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
function worstCaseUsd({ lane, skill, effect, judgeModel }) {
  let usd = 0;
  for (const fixture of LINQ_EFFECT_FIXTURES) {
    const userMessage = effect.linqEffectUserMessage(fixture.input);
    const writerInput =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: effect.LINQ_EFFECT_TOOL,
        input_schema: effect.LINQ_EFFECT_TOOL_SCHEMA,
      });
    usd += priced(lane.model, writerInput, effect.LINQ_EFFECT_MAX_TOKENS);
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens(judgePayload(fixture, userMessage, BROKEN_DECISION)) +
      estimateTokens(JUDGE_SCHEMA);
    usd += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
  }
  return usd;
}

function priceLine(usd, lane, judgeModel) {
  return `linq-effect: worst case to record ${LINQ_EFFECT_FIXTURES.length} fixtures (writer ${lane.model} + judge ${judgeModel}), every call at max_tokens, no cache reads. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const record = process.argv.includes('--record');
  if ([dry, broken, cachedOnly, record].filter(Boolean).length !== 1) {
    console.error(
      'linq-effect: pass exactly one of --dry, --cached-only, --broken or --record. Only --record calls the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const effect = await importTs(EFFECT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = worstCaseUsd({ lane, skill, effect, judgeModel });

  if (dry) {
    console.info(priceLine(usd, lane, judgeModel));
    return;
  }

  if (broken) {
    let rejected = 0;
    for (const fixture of LINQ_EFFECT_FIXTURES) {
      const refusals = effect.linqEffectRefusals(BROKEN_DECISION, fixture.input.reply);
      if (refusals.length > 0) rejected += 1;
      console.info(
        `${refusals.length > 0 ? 'FAIL' : 'PASS'}  ${fixture.id.padEnd(26)} ${refusals.map((r) => `unsendable:${r}`).join(' ')}`,
      );
    }
    console.info(
      `linq-effect --broken: ${rejected}/${LINQ_EFFECT_FIXTURES.length} rejected by the send gate. live API calls: 0.`,
    );
    process.exit(rejected > 0 ? 1 : 0);
  }

  if (cachedOnly) console.info(priceLine(usd, lane, judgeModel));
  if (record) installEvalSpendCap();
  const getClient = lazyAnthropic('linq-effect');
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'linq-effect', cachedOnly, getClient, cost);

  console.info(
    `linq-effect eval | mode=${record ? 'record' : 'cached-only'} | subject=${lane.model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of LINQ_EFFECT_FIXTURES) {
    const userMessage = effect.linqEffectUserMessage(fixture.input);
    const { value } = await cachedToolCall({
      tag: `linq-effect:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage,
      toolName: effect.LINQ_EFFECT_TOOL,
      toolSchema: effect.LINQ_EFFECT_TOOL_SCHEMA,
      toolDescription: 'Return the iMessage effect to send with the reply, or null.',
      maxTokens: effect.LINQ_EFFECT_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const decision = {
      effect: value?.effect && typeof value.effect === 'object' ? value.effect : null,
    };
    const failures = effect
      .linqEffectRefusals(decision, fixture.input.reply)
      .map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, judgePayload(fixture, userMessage, decision));
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, decision, failures });
  }
  for (const r of results) {
    const name = r.decision.effect ? `${r.decision.effect.type}:${r.decision.effect.name}` : '-';
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} effect=${name}`,
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
    console.error('linq-effect eval harness error:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
