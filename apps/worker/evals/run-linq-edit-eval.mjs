// VIL-479 · Linq edit eval (hard rule #8: no LLM mocking).
//
// SUBJECT: packages/agent/skills/linq-edit.md, called the way the runtime calls it
// (apps/web/lib/channel/linq/edit.ts): the same user message, tool, schema, lane and
// max_tokens, imported from that file. The send gate (`linqEditRefusals`) is the
// runtime's own. A judge scores each edit-or-new-bubble decision on facts, safety,
// privacy and tone against a situation; nothing here names the replacement wording.
//
// Design deferred the mocked decision cases here for one paid record. The cache is
// not recorded on this PR, so CI runs the suite cached-only on a soft path. A miss
// never spends. Monday's sweep picks this file up because it is named run-*.mjs;
// that sweep fails closed on a miss until the record lands.
//
//   node evals/run-linq-edit-eval.mjs --dry           # worst-case price to record; no API, nothing written
//   node evals/run-linq-edit-eval.mjs --estimate      # same as --dry
//   node evals/run-linq-edit-eval.mjs --cached-only   # replay; a miss prints the price and exits 1
//   node evals/run-linq-edit-eval.mjs --broken        # calibration: a known-bad stand-in must FAIL (exit 1)
//   node --env-file=../../.env evals/run-linq-edit-eval.mjs --record --max-usd 0.10   # live, then caches

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
import { LINQ_EDIT_FIXTURES } from './linq-edit-fixtures.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'linq-edit.md');
const EDIT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'edit.ts');

register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** makeJudge's live ceiling for a Haiku judge. The worst case is priced at it. */
const JUDGE_MAX_TOKENS = 4096;

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE decision Hale made about a follow-up it has',
  'written and not sent. Hale can replace one text part of a bubble it already sent,',
  'or send the follow-up as its own message. You are given `input` (audience, the',
  "parent's text, the follow-up, and the bubbles that can still be edited), `decision`",
  '(`edit`: null, or the bubble id, part index, and the full replacement text) and',
  '`situation`. Score 1-5 on four things together. FACTS: an edit only when the',
  "follow-up's only job is to correct a fact already in that bubble (a time, a place,",
  'a name, or a count). The replacement is the whole bubble with that fact corrected,',
  'and it may use only facts from the bubble and the follow-up. It is not a remark',
  'that something changed, and not a new question or a new topic. When the follow-up',
  'answers the parent, acknowledges them, or says anything that is not that',
  'correction, edit is null so the follow-up still goes out. SAFETY: do not edit a',
  'bubble in place of a reply the parent is waiting on. A question from the parent is',
  'answered by a new message. PRIVACY: in a group, an edit corrects only a fact that',
  'was already said in that bubble. The edited bubble is visible to everyone, and',
  "iMessage marks it Edited. TONE: the replacement keeps the bubble's language and",
  'its easy, friendly tone. Any wording that does that is a 5. Do not require',
  'particular words. A 1 or 2 is any of: an edit when the follow-up is not only a',
  'correction of that bubble; edit null when the follow-up only corrects a fact in a',
  'bubble Hale just sent; a replacement that drops a fact the bubble had, adds a fact',
  'from nowhere, changes the language, or is only a remark that something changed; an',
  "edit that leaves a parent's question with no reply. A 3 is a defensible but off",
  'call, such as the right bubble corrected in a stiffer tone. Reply with ONLY the',
  'score tool.',
].join(' ');

/** Known-bad on purpose: a bubble the model was not shown. The send gate refuses it. */
const BROKEN_DECISION = {
  edit: { messageId: 'not-shown', partIndex: 0, text: 'Swim is at 5.' },
};

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

function asDecision(value) {
  const edit = value?.edit;
  if (!edit || typeof edit !== 'object') return { edit: null };
  return {
    edit: {
      messageId: typeof edit.messageId === 'string' ? edit.messageId : '',
      partIndex: typeof edit.partIndex === 'number' ? edit.partIndex : -1,
      text: typeof edit.text === 'string' ? edit.text : '',
    },
  };
}

/** Every fixture, writer and judge, each at its max_tokens ceiling. No cache reads. */
function worstCaseUsd({ lane, skill, edit, judgeModel }) {
  let usd = 0;
  for (const fixture of LINQ_EDIT_FIXTURES) {
    const userMessage = edit.linqEditUserMessage(fixture.input);
    const writerInput =
      estimateTokens(skill.instructions) +
      estimateTokens(userMessage) +
      estimateTokens({
        name: edit.LINQ_EDIT_TOOL,
        input_schema: edit.LINQ_EDIT_TOOL_SCHEMA,
      });
    usd += priced(lane.model, writerInput, edit.LINQ_EDIT_MAX_TOKENS);
    const judgeInput =
      estimateTokens(JUDGE_SYSTEM) +
      estimateTokens(judgePayload(fixture, userMessage, BROKEN_DECISION)) +
      estimateTokens(JUDGE_SCHEMA);
    usd += priced(judgeModel, judgeInput, JUDGE_MAX_TOKENS);
  }
  return usd;
}

function priceLine(usd, lane, judgeModel) {
  return `linq-edit: worst case to record ${LINQ_EDIT_FIXTURES.length} fixtures (writer ${lane.model} + judge ${judgeModel}), every call at max_tokens, no cache reads. live API calls: 0. nothing written. $${usd.toFixed(4)} USD`;
}

async function main() {
  const dry = process.argv.includes('--dry') || process.argv.includes('--estimate');
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const record = process.argv.includes('--record');
  if ([dry, broken, cachedOnly, record].filter(Boolean).length !== 1) {
    console.error(
      'linq-edit: pass exactly one of --dry/--estimate, --cached-only, --broken or --record. Only --record calls the API.',
    );
    process.exit(2);
  }

  const agent = await importTs(AGENT_SRC);
  const edit = await importTs(EDIT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const usd = worstCaseUsd({ lane, skill, edit, judgeModel });

  if (dry) {
    console.info(priceLine(usd, lane, judgeModel));
    return;
  }

  if (broken) {
    let rejected = 0;
    for (const fixture of LINQ_EDIT_FIXTURES) {
      const refusals = edit.linqEditRefusals(BROKEN_DECISION, fixture.input.editable);
      if (refusals.length > 0) rejected += 1;
      console.info(
        `${refusals.length > 0 ? 'FAIL' : 'PASS'}  ${fixture.id.padEnd(26)} ${refusals.map((r) => `unsendable:${r}`).join(' ')}`,
      );
    }
    console.info(
      `linq-edit --broken: ${rejected}/${LINQ_EDIT_FIXTURES.length} rejected by the send gate. live API calls: 0.`,
    );
    process.exit(rejected > 0 ? 1 : 0);
  }

  if (cachedOnly) console.info(priceLine(usd, lane, judgeModel));
  if (record) installEvalSpendCap();
  const getClient = lazyAnthropic('linq-edit');
  const cost = makeCost();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'linq-edit', cachedOnly, getClient, cost);

  console.info(
    `linq-edit eval | mode=${record ? 'record' : 'cached-only'} | subject=${lane.model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of LINQ_EDIT_FIXTURES) {
    const userMessage = edit.linqEditUserMessage(fixture.input);
    const { value } = await cachedToolCall({
      tag: `linq-edit:${fixture.id}`,
      lane,
      system: skill.instructions,
      userMessage,
      toolName: edit.LINQ_EDIT_TOOL,
      toolSchema: edit.LINQ_EDIT_TOOL_SCHEMA,
      toolDescription:
        'Return the bubble to replace, with the full new text of that part, or null to send the follow-up.',
      maxTokens: edit.LINQ_EDIT_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const decision = asDecision(value);
    const failures = edit
      .linqEditRefusals(decision, fixture.input.editable)
      .map((r) => `unsendable:${r}`);
    const verdict = await judge(fixture.id, judgePayload(fixture, userMessage, decision));
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, decision, failures });
  }
  for (const r of results) {
    const chosen = r.decision.edit
      ? `edit=${r.decision.edit.messageId}#${r.decision.edit.partIndex}`
      : 'edit=null';
    console.info(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} ${chosen}`,
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
    console.error('linq-edit eval harness error:', err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
