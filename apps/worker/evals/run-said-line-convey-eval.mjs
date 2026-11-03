// VIL-530 · mustConvey meaning judge (hard rule #8: no LLM mocking).
//
// Subject: the production convey judge (skill said-line-convey-judge, the request
// from said-line-convey.ts). It does not write a line. `conveyed: no`, or a judge
// that does not return a verdict, is a miss: production sends nothing and does
// not rewrite the draft.
//
//   node evals/run-said-line-convey-eval.mjs --dry           # $0, no API
//   node evals/run-said-line-convey-eval.mjs --cached-only   # replay; misses fail
//   node evals/run-said-line-convey-eval.mjs --broken        # every draft omits; judge must omit
//   node --env-file=../../.env evals/run-said-line-convey-eval.mjs --live   # PAID
//
// Meaning is this cached judge, not a scripted verdict. CI runs --cached-only as a
// soft path until the Nov 1 ~9:05 ET paid re-record: there is no recording yet, a
// miss fails this process, and the workflow marks that step continue-on-error.
// Do not delete the judge to keep the step green. --dry stays a hard $0 check of
// the request. This file does not spend.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { estimateTokens, noClient, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import {
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import {
  SAID_LINE_CONVEY_FIXTURES,
  conveyFacts,
  conveyUserMessage,
} from './said-line-convey-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');
const CONVEY_SRC = join(WEB_ROOT, 'lib', 'channel', 'voice', 'said-line-convey.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/** Eval input only. Production never sends this, and never uses it as a fallback. */
const OMISSION = 'Got it.';

function grade(conveyed, expected) {
  if (conveyed !== 'yes' && conveyed !== 'no') return 'judge returned no verdict';
  const verdict = conveyed === 'yes' ? 'send' : 'omit';
  if (verdict !== expected) return `judge said ${verdict}, corpus expects ${expected}`;
  return null;
}

async function loadRequest(draft) {
  const convey = await importTs(CONVEY_SRC);
  const facts = conveyFacts();
  const request = await convey.saidLineConveyRequest(draft, facts);
  const pinned = conveyUserMessage(draft);
  if (request.userMessage !== pinned) {
    throw new Error('convey judge user message drifted from the fixture payload');
  }
  const prose = request.system.replace(/\s+/g, ' ');
  if (prose.includes('pendingClosed') || /\w+\|\w+/.test(prose) || prose.includes('>')) {
    throw new Error('convey judge skill is matching words or naming a fact key');
  }
  return request;
}

async function dryRun() {
  const facts = conveyFacts();
  if (facts.length !== 1 || facts[0].key !== 'pendingClosed') {
    throw new Error('corpus must judge pendingClosed');
  }
  const expects = new Set(SAID_LINE_CONVEY_FIXTURES.map((fixture) => fixture.expect));
  if (!expects.has('send') || !expects.has('omit')) {
    throw new Error('corpus needs both a send and an omit');
  }
  let usd = 0;
  let calls = 0;
  let model = '';
  for (const fixture of SAID_LINE_CONVEY_FIXTURES) {
    const request = await loadRequest(fixture.draft);
    model = request.lane.model;
    // forceToolJson may re-ask once, so a miss is priced as two calls at the ceiling.
    const once = worstCaseUsd(
      model,
      estimateTokens(`${request.system}\n${request.userMessage}`),
      request.maxTokens,
    );
    usd += once * 2;
    calls += 2;
    console.log(`${fixture.id} | expect ${fixture.expect} | priced, not called`);
  }
  console.log(
    `said-line-convey | dry | judge=${model} | fixtures=${SAID_LINE_CONVEY_FIXTURES.length} | calls at most ${calls} | worst $${usd.toFixed(6)} | live calls: 0`,
  );
}

async function runJudged(mode) {
  const broken = mode === 'broken';
  const cachedOnly = mode !== 'live';
  installEvalSpendCap();
  const getClient =
    mode === 'live' ? lazyAnthropic('said-line-convey') : noClient('said-line-convey');
  const cost = makeCost();
  const failures = [];
  for (const fixture of SAID_LINE_CONVEY_FIXTURES) {
    const draft = broken ? OMISSION : fixture.draft;
    const expected = broken ? 'omit' : fixture.expect;
    const request = await loadRequest(draft);
    const judged = await cachedToolCall({
      tag: `said-line-convey:${broken ? 'broken:' : ''}${fixture.id}`,
      lane: request.lane,
      system: request.system,
      userMessage: request.userMessage,
      toolName: request.toolName,
      toolSchema: request.toolSchema,
      toolDescription: request.toolDescription,
      maxTokens: request.maxTokens,
      cachedOnly,
      getClient,
      cost,
    });
    const problem = grade(judged.value?.conveyed, expected);
    if (problem) failures.push(`${fixture.id}: ${problem}`);
  }
  console.log(
    `said-line-convey | ${mode} | fixtures=${SAID_LINE_CONVEY_FIXTURES.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  for (const line of failures) console.error(line);
  if (failures.length > 0) process.exit(1);
}

async function main() {
  const mode = parseEvalFlagsOrExit('said-line-convey');
  if (mode === 'dry') {
    await dryRun();
    return;
  }
  await runJudged(mode);
}

main().catch((err) => {
  console.error('said-line-convey eval harness error:', err);
  process.exit(1);
});
