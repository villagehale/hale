// The offer receipt · composer eval.
//
// The subject is the REAL skill (packages/agent/skills/offer-receipt.md) over the
// REAL user message and tool schema from apps/web/lib/integrations/offer-receipt.ts.
// A judge scores facts and tone. Nothing matches words.
//
// Unrecorded. Record from a machine that has a key, then replay:
//   node evals/run-offer-receipt-eval.mjs --max-usd 0.05
//   node evals/run-offer-receipt-eval.mjs --print-keys
//   node evals/run-offer-receipt-eval.mjs --cached-only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  cacheKey,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { OFFER_RECEIPT_FIXTURES } from './offer-receipt-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'offer-receipt.md');
const RECEIPT_SRC = join(WEB_ROOT, 'lib', 'integrations', 'offer-receipt.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends a parent after they answered a calendar offer.',
  'You are given the facts as JSON, the text, and watchFor notes. Score 1-5 on FACTS and TONE.',
  'Do not score wording, phrasing, or which words were chosen.',
  'A 5 states the facts: what happened, the title unchanged, the rendered instant unchanged,',
  'whether Google calendar is connected, and where the entry went. It is in the language of',
  'parentReply. It is first person, short, plain, and warm. It does not say Hale booked,',
  'registered, or paid.',
  'A LOW score is any of: a place the facts do not name; the entry on the parent’s Google',
  'calendar when googleCalendarConnected is false or placedOn is hale_family_calendar;',
  'Google described as not connected when googleCalendarConnected is true; a dropped or',
  'changed title or rendered instant; the wrong language; in French, vous; blame, system',
  'talk, hype, emoji, exclamation marks, telling them which word to send; more than about',
  'two short sentences.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN = 'Done!! Added to your Google Calendar 🎉 reply YES to confirm';

/** The compose cache key for one fixture. The same bytes cachedToolCall hashes. */
export function offerReceiptComposeKey({ id, model, lane, system, userMessage, toolSchema }) {
  const canonical = JSON.stringify({
    model,
    system,
    userMessage,
    toolName: 'receipt',
    toolSchema,
    lane,
  });
  return cacheKey(`offer-receipt:${id}`, canonical);
}

async function loadSubject() {
  const agent = await importTs(AGENT_SRC);
  const receipt = await importTs(RECEIPT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  return { agent, receipt, skill, lane, model: lane.model };
}

async function printKeys() {
  const { receipt, skill, lane, model } = await loadSubject();
  for (const fixture of OFFER_RECEIPT_FIXTURES) {
    const userMessage = receipt.offerReceiptUserMessage(fixture.facts);
    const key = offerReceiptComposeKey({
      id: fixture.id,
      model,
      lane,
      system: skill.instructions,
      userMessage,
      toolSchema: receipt.offerReceiptToolSchema,
    });
    console.log(`${fixture.id}\t${key}`);
  }
}

async function main() {
  if (process.argv.includes('--print-keys')) {
    await printKeys();
    return;
  }
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('offer-receipt');
  const cost = makeCost();
  const { receipt, skill, lane, model } = await loadSubject();
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'offer-receipt', cachedOnly, getClient, cost);

  console.log(
    `offer-receipt eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of OFFER_RECEIPT_FIXTURES) {
    const userMessage = receipt.offerReceiptUserMessage(fixture.facts);
    const body = broken
      ? BROKEN
      : String(
          (
            await cachedToolCall({
              tag: `offer-receipt:${fixture.id}`,
              model,
              lane,
              system: skill.instructions,
              userMessage,
              toolName: 'receipt',
              toolSchema: receipt.offerReceiptToolSchema,
              toolDescription: 'Write the one short receipt for this calendar offer.',
              maxTokens: 128,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.line ?? '',
        ).trim();
    const failures = receipt.receiptLineOk(body, fixture.facts) ? [] : ['unsendable'];
    const verdict = await judge(fixture.id, {
      input: userMessage,
      text: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ fixture, body, failures });
  }
  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(26)} "${r.body}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().catch((err) => {
    console.error('offer-receipt eval harness error:', err);
    process.exit(2);
  });
}
