// The approval receipt · composer eval (VIL-454 T6 3/3, hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/approval-receipt.md) over the
// REAL input and gates: `approvalReceiptInput`, `approvalReceiptUserMessage` and
// `approvalReceiptRefusals` are imported from apps/web/lib/channel/router/approval-receipt.ts.
// A judge scores facts and tone; nothing matches words.
//
// Recorded 2026-10-25 (6/6, $0.0007, ledger vil454-evals). CI replays it cached-only:
//   node evals/run-approval-receipt-eval.mjs --max-usd 0.05   # live, then caches
//   node evals/run-approval-receipt-eval.mjs --broken         # calibration: must FAIL
//   node evals/run-approval-receipt-eval.mjs --cached-only    # CI: replay only

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { APPROVAL_RECEIPT_FIXTURES } from './approval-receipt-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'approval-receipt.md');
const NOTICE_SRC = join(WEB_ROOT, 'lib', 'channel', 'router', 'approval-receipt.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE short text Hale sends a parent in a 1:1 chat right after',
  'they answered a change Hale had drafted, or asked to take the last one back. You are given the',
  'input (kind, action, language), the text and watchFor notes. Score 1-5 on FACTS and TONE, not',
  'wording. A 5 says exactly what kind records and nothing more, in input.language, first person,',
  'short, plain and warm like a friend. Score LOW when it claims more happened than kind records,',
  'invents a detail, is in the wrong language, or reads like a system message or a sales line.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN = 'Done!! Added to your Google Calendar 🎉 reply YES to confirm www.example.com';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('approval-receipt');
  const cost = makeCost();
  const agent = await importTs(AGENT_SRC);
  const notice = await importTs(NOTICE_SRC);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const lane = agent.pickLane(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'approval-receipt',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `approval-receipt eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of APPROVAL_RECEIPT_FIXTURES) {
    const input = notice.approvalReceiptInput(...fixture.args);
    const userMessage = notice.approvalReceiptUserMessage(input);
    const body = broken
      ? BROKEN
      : String(
          (
            await cachedToolCall({
              tag: `approval-receipt:${fixture.id}`,
              model,
              lane,
              system: skill.instructions,
              userMessage,
              toolName: 'approval_receipt',
              toolSchema: TOOL_SCHEMA,
              toolDescription: 'The one short text Hale sends back.',
              maxTokens: 200,
              cachedOnly,
              getClient,
              cost,
            })
          ).value.text ?? '',
        ).trim();
    const failures = notice.approvalReceiptRefusals(body).map((r) => `unsendable:${r}`);
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
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(22)} "${r.body}"`,
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

main().catch((err) => {
  console.error('approval-receipt eval harness error:', err);
  process.exit(2);
});
