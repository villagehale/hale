// VIL-540 · holding-line meaning judge (hard rule #8: no LLM mocking).
//
// Subject: the production judge (skill holding-line-judge, the request from
// holding-line-judge.ts). It does not write a line. A `yes` on a promised time
// or an app/website, or a judge that does not return a verdict, is a miss:
// production sends nothing and does not substitute a fixed line.
//
//   node evals/run-holding-line-judge-eval.mjs --dry           # $0, no API
//   node evals/run-holding-line-judge-eval.mjs --cached-only   # replay; misses fail
//   node evals/run-holding-line-judge-eval.mjs --broken        # every line is poisoned
//   node --env-file=../../.env evals/run-holding-line-judge-eval.mjs --live   # PAID
//
// Meaning is this cached judge, not a scripted verdict. CI runs --cached-only as a
// soft path until the paid batch records EN, FR and ZH together: there is no
// recording yet, a miss fails this process, and the workflow marks that step
// continue-on-error. Do not delete the judge to keep the step green. --dry stays
// a hard $0 check of the request. This file does not spend.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { HOLDING_LINE_JUDGE_FIXTURES, judgeUserMessage } from './holding-line-judge-fixtures.mjs';
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
const JUDGE_SRC = join(WEB_ROOT, 'lib', 'channel', 'router', 'holding-line-judge.ts');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

/**
 * Eval input only. Production never sends this, and never uses it as a fallback
 * when the judge misses. It promises a time and points at a website, so a judge
 * that is awake refuses it on both counts.
 */
const POISON = 'I will have it shortly, and the rest is on the website.';

const WORD_LIST = ['shortly', 'momentarily', 'jiffy', 'dashboard', 'villagehale'];

function grade(value, expected) {
  const time = value?.promises_a_time;
  const place = value?.points_at_an_app;
  if (time !== 'yes' && time !== 'no') return 'judge returned no time verdict';
  if (place !== 'yes' && place !== 'no') return 'judge returned no place verdict';
  if (expected === 'clear') {
    if (time !== 'no' || place !== 'no') {
      return `judge refused a clear line (time=${time} place=${place})`;
    }
    return null;
  }
  if (expected === 'promised_a_time' && time !== 'yes') return 'judge missed a promised time';
  if (expected === 'points_at_an_app' && place !== 'yes') return 'judge missed an app or a website';
  if (expected === 'both' && (time !== 'yes' || place !== 'yes')) {
    return `judge missed a time or a place (time=${time} place=${place})`;
  }
  return null;
}

async function loadRequest(line) {
  const judge = await importTs(JUDGE_SRC);
  const request = await judge.holdingLineJudgeRequest(line);
  if (request.userMessage !== judgeUserMessage(line)) {
    throw new Error('holding-line judge user message drifted from the fixture payload');
  }
  const prose = request.system.replace(/\s+/g, ' ');
  if (prose.includes('>') || /\w+\|\w+/.test(prose) || /"[^"]{8,}"/.test(prose)) {
    throw new Error('holding-line judge skill lists words or example phrases');
  }
  const folded = prose.toLowerCase();
  for (const word of WORD_LIST) {
    if (folded.includes(word)) {
      throw new Error('holding-line judge skill lists words or example phrases');
    }
  }
  if (!prose.includes('whatever language') || !prose.includes('do not rewrite')) {
    throw new Error('holding-line judge skill lost its meaning-only direction');
  }
  return request;
}

function assertCorpus() {
  const languages = new Set(HOLDING_LINE_JUDGE_FIXTURES.map((fixture) => fixture.language));
  for (const language of ['en', 'fr', 'zh']) {
    if (!languages.has(language)) throw new Error(`corpus is missing ${language}`);
  }
  const expects = new Set(HOLDING_LINE_JUDGE_FIXTURES.map((fixture) => fixture.expect));
  for (const expect of ['clear', 'promised_a_time', 'points_at_an_app']) {
    if (!expects.has(expect)) throw new Error(`corpus is missing a ${expect} line`);
  }
}

async function dryRun() {
  assertCorpus();
  let usd = 0;
  let calls = 0;
  let model = '';
  for (const fixture of HOLDING_LINE_JUDGE_FIXTURES) {
    const request = await loadRequest(fixture.line);
    model = request.lane.model;
    // forceToolJson can re-ask once when the reply is empty, and once more when
    // that reply spent its budget thinking. A miss is priced as three calls at
    // the ceiling, with the schema counted in the input and no cache discount.
    const input = [
      request.system,
      request.userMessage,
      request.toolDescription,
      JSON.stringify(request.toolSchema),
    ].join('\n');
    const once = worstCaseUsd(model, estimateTokens(input), request.maxTokens);
    usd += once * 3;
    calls += 3;
    console.log(
      `${fixture.id} | ${fixture.language} | expect ${fixture.expect} | priced, not called`,
    );
  }
  console.log(
    `holding-line-judge | dry | judge=${model} | fixtures=${HOLDING_LINE_JUDGE_FIXTURES.length} | calls at most ${calls} | worst $${usd.toFixed(6)} | live calls: 0`,
  );
}

async function runJudged(mode) {
  assertCorpus();
  const broken = mode === 'broken';
  const cachedOnly = mode !== 'live';
  installEvalSpendCap();
  const getClient =
    mode === 'live' ? lazyAnthropic('holding-line-judge') : noClient('holding-line-judge');
  const cost = makeCost();
  const failures = [];
  for (const fixture of HOLDING_LINE_JUDGE_FIXTURES) {
    const line = broken ? POISON : fixture.line;
    const expected = broken ? 'both' : fixture.expect;
    const request = await loadRequest(line);
    const judged = await cachedToolCall({
      tag: `holding-line-judge:${broken ? 'broken:' : ''}${fixture.id}`,
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
    const problem = grade(judged.value, expected);
    if (problem) failures.push(`${fixture.id}: ${problem}`);
  }
  console.log(
    `holding-line-judge | ${mode} | fixtures=${HOLDING_LINE_JUDGE_FIXTURES.length} | failures=${failures.length} | $${totalUsd(cost).toFixed(4)} | live calls: ${cost.liveCalls}`,
  );
  for (const line of failures) console.error(line);
  if (failures.length > 0) process.exit(1);
}

async function main() {
  const mode = parseEvalFlagsOrExit('holding-line-judge');
  if (mode === 'dry') {
    await dryRun();
    return;
  }
  await runJudged(mode);
}

main().catch((err) => {
  console.error('holding-line-judge eval harness error:', err);
  process.exit(1);
});
