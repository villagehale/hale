// The offer receipt · composer eval.
//
// The subject is the REAL skill (packages/agent/skills/offer-receipt.md) over the
// REAL user message and tool schema from apps/web/lib/integrations/offer-receipt.ts.
// A judge scores facts and tone. Nothing matches words. Length is the model's
// judgment: there is no segment cap and no English includes() gate.
//
// Unrecorded. Price with --dry. Record from a machine that has a key, then replay:
//   node evals/run-offer-receipt-eval.mjs --dry
//   node evals/run-offer-receipt-eval.mjs --live --max-usd 0.05
//   node evals/run-offer-receipt-eval.mjs --cached-only
//   node evals/run-offer-receipt-eval.mjs --broken --cached-only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { judgePrompt } from './lib/judge-prompt.mjs';
import { OFFER_RECEIPT_FIXTURES } from './offer-receipt-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'offer-receipt.md');
const RECEIPT_SRC = join(WEB_ROOT, 'lib', 'integrations', 'offer-receipt.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const JUDGE_SYSTEM = judgePrompt('offer-receipt');

const BROKEN = 'Done!! Added to your Google Calendar 🎉 reply YES to confirm';

async function loadSubject() {
  const agent = await importTs(AGENT_SRC);
  const receipt = await importTs(RECEIPT_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const lane = agent.pickLane(skill.meta.task);
  return { receipt, skill, lane, model: lane.model };
}

async function main() {
  assertRunFlags(['--broken', '--env-file', '--max-usd']);
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const dry = isDryRun();
  installEvalSpendCap();
  const getClient = lazyAnthropic('offer-receipt');
  const cost = makeCost();
  const { receipt, skill, lane, model } = await loadSubject();
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'offer-receipt', cachedOnly, getClient, cost);

  console.log(
    `offer-receipt eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''}${dry ? ' (dry)' : ''} | compose=${model} judge=${judgeModel}`,
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
              toolName: receipt.OFFER_RECEIPT_TOOL,
              toolSchema: receipt.offerReceiptToolSchema,
              toolDescription: receipt.OFFER_RECEIPT_TOOL_DESCRIPTION,
              maxTokens: receipt.OFFER_RECEIPT_MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.line ?? '',
        ).trim();
    const failures = body === '' ? ['empty'] : [];
    const verdict = await judge(fixture.id, {
      input: userMessage,
      text: body,
      watchFor: fixture.watchFor,
    });
    if (!dry && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, body, failures });
  }
  if (dry) {
    console.log(dryReportLine('offer-receipt', [judge.plan]));
    return;
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
