// VIL-79 · judge calibration for the coach kid-clash cases (coach-clash-fixtures.mjs).
//
// The subject turn runs in the VIL-467 coach batch, not here. This runner grades each
// case's reference reply (must PASS where shouldPass) and the clash-dropped broken case
// (must FAIL) with the shared Sonnet judge, median of three — so the gate is proven to
// tell them apart before any paid subject run.
//
//   node evals/run-coach-clash-eval.mjs --dry          # price uncached judge draws, 0 calls
//   node evals/run-coach-clash-eval.mjs --cached-only  # CI replay
//   node evals/run-coach-clash-eval.mjs --broken       # grades every `broken` reply: must FAIL
//   (live recording needs --env-file + HALE_SPEND_LEDGER and is NOT part of VIL-79)

import {
  CLASH_CHILDREN,
  CLASH_JUDGE_SYSTEM,
  COACH_CLASH_FIXTURES,
} from './coach-clash-fixtures.mjs';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  PRICE,
  cacheGet,
  cacheKey,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readModelIds,
} from './lib/harness.mjs';

const dry = process.argv.includes('--dry');
const cachedOnly = process.argv.includes('--cached-only');
const broken = process.argv.includes('--broken');
const TAG = 'coach-clash';

function payloadFor(fixture, reply) {
  return {
    parentText: fixture.text,
    children: CLASH_CHILDREN.map((c) => ({ id: c.id, name: c.name })),
    calendarBlocks: fixture.calendarBlocks,
    toolResult: fixture.toolResult,
    reply,
  };
}

async function main() {
  const judgeModel = (await readModelIds()).judge;
  const cases = COACH_CLASH_FIXTURES.map((fixture) => {
    const reply = broken ? fixture.sample.broken : fixture.sample.reply;
    const shouldPass = broken ? false : fixture.clashJudge.shouldPass;
    return { fixture, reply, shouldPass, tag: `${fixture.id}${broken ? ':broken' : ''}` };
  });
  console.log(
    `coach-clash-eval | mode=${dry ? 'dry' : broken ? 'broken' : cachedOnly ? 'cached-only' : 'real'} | judge=${judgeModel} x${JUDGE_SAMPLES_MEDIAN} | cases ${cases.length}`,
  );

  if (dry) {
    const rates = PRICE[judgeModel];
    if (!rates) throw new Error(`no price for ${judgeModel}`);
    const maxOut = 8192; // makeJudge's non-Haiku ceiling (thinking included)
    let cached = 0;
    let uncached = 0;
    let worst = 0;
    for (const c of [...cases, ...(broken ? [] : brokenCases())]) {
      const userMessage = JSON.stringify(payloadFor(c.fixture, c.reply));
      for (let i = 0; i < JUDGE_SAMPLES_MEDIAN; i += 1) {
        const sampleTag = i === 0 ? `${TAG}:judge:${c.tag}` : `${TAG}:judge:${c.tag}#${i}`;
        const key = cacheKey(sampleTag, `${judgeModel}\n${CLASH_JUDGE_SYSTEM}\n${userMessage}`);
        if (await cacheGet(key)) {
          cached += 1;
          console.log(`DRY  cached    ${sampleTag}`);
          continue;
        }
        const inTokens = Math.ceil((CLASH_JUDGE_SYSTEM.length + userMessage.length) / 3);
        const usd = (inTokens / 1e6) * rates.input + (maxOut / 1e6) * rates.output;
        uncached += 1;
        worst += usd;
        console.log(
          `DRY  uncached  ${sampleTag}  ~${inTokens} in + ${maxOut} max out  worst $${usd.toFixed(5)}`,
        );
      }
    }
    console.log(
      `DRY summary | judge draws ${cached + uncached} (cached ${cached}, uncached ${uncached}) worst $${worst.toFixed(5)} | subject calls 0 (subject runs in the VIL-467 batch)`,
    );
    console.log('DRY: input tokens are an offline estimate (1 per 3 bytes); live calls: 0');
    return;
  }

  installEvalSpendCap();
  const cost = makeCost();
  const judge = makeJudge(
    judgeModel,
    CLASH_JUDGE_SYSTEM,
    TAG,
    cachedOnly || broken,
    lazyAnthropic('coach-clash-judge'),
    cost,
    {
      samples: JUDGE_SAMPLES_MEDIAN,
    },
  );
  let failures = 0;
  for (const c of cases) {
    const verdict = await judge(c.tag, payloadFor(c.fixture, c.reply));
    const passed = verdict.score >= JUDGE_MIN;
    const ok = passed === c.shouldPass;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${c.tag} judge:${verdict.score} (${verdict.samples?.join('/') ?? ''}) expect ${c.shouldPass ? 'pass' : 'fail'}`,
    );
  }
  console.log(`overall: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} wrong)`);
  process.exit(failures === 0 ? 0 : 1);
}

/** The broken replies, priced in the same dry run so one approval covers both sides. */
function brokenCases() {
  return COACH_CLASH_FIXTURES.filter((f) => f.sample.broken !== f.sample.reply).map((fixture) => ({
    fixture,
    reply: fixture.sample.broken,
    shouldPass: false,
    tag: `${fixture.id}:broken`,
  }));
}

await main();
