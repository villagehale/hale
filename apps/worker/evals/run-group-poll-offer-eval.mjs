// Group poll offer eval (VIL-458 slice 2, hard rule #8: no LLM mocking).
//
// Subject is the REAL skill (group-poll-offer.md) through the REAL request builder
// imported from group-poll-offer.ts. The gate is offer vs no-offer. No word in any
// message is checked. A later recording can add a copy judge; this runner prices
// and grades the offer decision.
//
//   node evals/run-group-poll-offer-eval.mjs --dry           # $0, no API: worst-case $
//   node evals/run-group-poll-offer-eval.mjs --broken        # $0 calibration: must FAIL
//   node evals/run-group-poll-offer-eval.mjs --cached-only   # CI: replay only, $0
//   node --env-file=../../.env evals/run-group-poll-offer-eval.mjs --live   # PAID
// Exactly one mode (lib/eval-flags.mjs).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { OFFER_FIXTURES } from './group-poll-offer-fixtures.mjs';
import { estimateTokens, noClient, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import {
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const OFFER_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-poll-offer.md');
const SRC = join(WEB_ROOT, 'lib', 'channel', 'linq', 'group-poll-offer.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const OFFER_MAX = 400;

async function main() {
  const mode = parseEvalFlagsOrExit('group-poll-offer');
  const agent = await importTs(AGENT_SRC);
  const src = await importTs(SRC);
  const skill = await agent.loadSkill(OFFER_SKILL);
  const model = agent.pickModel(skill.meta.task);
  if (mode === 'dry') {
    console.log(`group-poll-offer eval | mode=dry (no API calls) | offer=${model}`);
    let worst = 0;
    for (const f of OFFER_FIXTURES) {
      const inTok = estimateTokens(skill.instructions + src.pollOfferUserMessage(f.input));
      const usd = worstCaseUsd(model, inTok, OFFER_MAX);
      worst += usd;
      console.log(
        `DRY  group-poll-offer:${f.id}  ${model}  ~${inTok} in + ${OFFER_MAX} max out  worst $${usd.toFixed(5)}`,
      );
    }
    console.log(
      `DRY summary | ${OFFER_FIXTURES.length} calls, all priced as uncached | worst $${worst.toFixed(5)}`,
    );
    console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
    return;
  }
  const broken = mode === 'broken';
  installEvalSpendCap();
  const getClient =
    mode === 'live' ? lazyAnthropic('group-poll-offer') : noClient('group-poll-offer');
  const cost = makeCost();
  console.log(`group-poll-offer eval | mode=${mode} | offer=${model}`);
  const results = [];
  for (const f of OFFER_FIXTURES) {
    let reading;
    if (broken) {
      // A naive offer: always send, options invented. Must fail the no-offer cases.
      reading = { offer: true, prompt: 'Pick one', options: ['A', 'B'] };
    } else {
      const { value } = await cachedToolCall({
        tag: `group-poll-offer:${f.id}`,
        model,
        lane: agent.pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: src.pollOfferUserMessage(f.input),
        toolName: 'group_poll_offer',
        toolSchema: src.POLL_OFFER_TOOL_SCHEMA,
        toolDescription:
          'Say whether Hale should offer a poll, and if so write it from the thread.',
        maxTokens: OFFER_MAX,
        cachedOnly: mode === 'cached-only',
        getClient,
        cost,
      });
      reading = src.pollOfferFromAnswer(value);
    }
    const got = reading?.offer ?? null;
    const misses = [];
    if (got !== f.accept.offer) misses.push(`offer=${got}`);
    if (f.accept.offer && reading && reading.options.length < 2) misses.push('options<2');
    results.push({ id: f.id, pass: misses.length === 0, detail: misses.join(' ') });
  }
  for (const r of results)
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(36)} ${r.detail}`);
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  const allPass = results.every((r) => r.pass);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('group-poll-offer eval harness error:', err);
  process.exit(2);
});
