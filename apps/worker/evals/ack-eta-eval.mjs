// VIL-717 · the slow-ask ack and the deadline-miss note (hard rule #8: no LLM mocking).
//
// Three suites, each on the production request (apps/web/lib/channel/ack-eta):
//   read    skill ack-eta-read: which slow job a text asks for (EN/FR/ZH x 4 categories).
//   judge   skill ack-eta-judge: the meaning gate, mapped by ackMeaningProblems.
//   writers skills ack-eta / ack-eta-miss: each draft through code's gate and the
//           production judge, with the same one redraft production allows. A draft
//           that cannot pass is a miss: production sends nothing.
//
//   node evals/ack-eta-eval.mjs --dry           # $0, no API: prices every request
//   node evals/ack-eta-eval.mjs --cached-only   # replay; a cache miss fails
//   node evals/ack-eta-eval.mjs --broken        # calibration: read + judge must FAIL
//   ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY_TEST" node evals/ack-eta-eval.mjs --live
//                                               # PAID, only on Barton's OK
//
// Named without the run- prefix until its one paid recording lands, so the every-eval
// cached-only sweep (scripts/ci/run-every-eval.sh) does not replay an empty cache. When
// recorded, rename to run-ack-eta-eval.mjs.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import {
  ACK_JUDGE_FIXTURES,
  ACK_READ_FIXTURES,
  ACK_WRITER_FIXTURES,
  gradeAckJudge,
  gradeAckRead,
} from './ack-eta-fixtures.mjs';
import { estimateTokens, noClient, parseEvalFlagsOrExit, worstCaseUsd } from './lib/eval-flags.mjs';
import {
  cachedToolCall,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACK_DIR = join(HERE, '..', '..', 'web', 'lib', 'channel', 'ack-eta');
const WEB_ROOT = join(HERE, '..', '..', 'web');

register({ tsconfig: join(WEB_ROOT, 'tsconfig.json') });
const importTs = (file) => import(pathToFileURL(join(ACK_DIR, file)).href);

const NAME = 'ack-eta';
const TASKS = ['registration', 'research', 'find', 'none'];

function assertCorpus() {
  for (const language of ['en', 'fr', 'zh']) {
    for (const task of TASKS) {
      if (!ACK_READ_FIXTURES.some((f) => f.language === language && f.expect === task)) {
        throw new Error(`read corpus is missing ${language} ${task}`);
      }
    }
    if (!ACK_JUDGE_FIXTURES.some((f) => f.language === language)) {
      throw new Error(`judge corpus is missing ${language}`);
    }
  }
  const named = new Set(ACK_JUDGE_FIXTURES.flatMap((f) => f.expect));
  for (const problem of [
    'no_time',
    'time_outside_window',
    'claims_done',
    'points_at_the_app',
    'promises_the_answer',
  ]) {
    if (!named.has(problem)) throw new Error(`judge corpus never expects ${problem}`);
  }
  if (!ACK_JUDGE_FIXTURES.some((f) => f.expect.length === 0)) {
    throw new Error('judge corpus has no clear line');
  }
}

function price(request, calls) {
  const input = [
    request.system,
    request.userMessage,
    request.toolDescription,
    JSON.stringify(request.toolSchema),
  ].join('\n');
  // forceToolJson may re-ask twice; every call is priced at the ceiling, uncached.
  return worstCaseUsd(request.lane.model, estimateTokens(input), request.maxTokens) * 3 * calls;
}

async function dryRun() {
  assertCorpus();
  const read = await importTs('read.ts');
  const judge = await importTs('judge.ts');
  const compose = await importTs('compose.ts');
  let usd = 0;
  let calls = 0;
  for (const f of ACK_READ_FIXTURES) {
    const request = await read.ackTaskReadRequest(f.text);
    usd += price(request, 1);
    calls += 3;
  }
  for (const f of ACK_JUDGE_FIXTURES) {
    const request = await judge.ackJudgeRequest(f.line, f.latestMinutes);
    usd += price(request, 1);
    calls += 3;
  }
  for (const f of ACK_WRITER_FIXTURES) {
    const request = await compose.ackDraftRequest(f.draft);
    const judged = await judge.ackJudgeRequest('a line of about this length', null);
    // Two drafts at most, each judged.
    usd += (price(request, 1) + price(judged, 1)) * compose.MAX_COMPOSE_ATTEMPTS;
    calls += 6 * compose.MAX_COMPOSE_ATTEMPTS;
  }
  console.log(
    `${NAME} | dry | read=${ACK_READ_FIXTURES.length} judge=${ACK_JUDGE_FIXTURES.length} writers=${ACK_WRITER_FIXTURES.length} | calls at most ${calls} | worst $${usd.toFixed(4)} | live calls: 0`,
  );
}

function call(request, tag, ctx) {
  return cachedToolCall({
    tag,
    lane: request.lane,
    system: request.system,
    userMessage: request.userMessage,
    toolName: request.toolName,
    toolSchema: request.toolSchema,
    toolDescription: request.toolDescription,
    maxTokens: request.maxTokens,
    cachedOnly: ctx.cachedOnly,
    getClient: ctx.getClient,
    cost: ctx.cost,
  });
}

async function verdict(judge, line, window, ctx) {
  const request = await judge.ackJudgeRequest(line, window.latestMinutes);
  const judged = await call(request, `${NAME}:judge:${line}`, ctx);
  return judge.ackMeaningProblems(judged.value, window);
}

async function runJudged(mode) {
  assertCorpus();
  const broken = mode === 'broken';
  installEvalSpendCap();
  const ctx = {
    cachedOnly: mode !== 'live',
    getClient: mode === 'live' ? lazyAnthropic(NAME) : noClient(NAME),
    cost: makeCost(),
  };
  const read = await importTs('read.ts');
  const judge = await importTs('judge.ts');
  const compose = await importTs('compose.ts');
  const { plainText } = await importTs('../coach/reply.ts');
  const failures = [];
  let graded = 0;

  for (const f of ACK_READ_FIXTURES) {
    const request = await read.ackTaskReadRequest(f.text);
    const answered = await call(request, `${NAME}:read:${f.id}`, ctx);
    const expected = broken ? (f.expect === 'none' ? 'find' : 'none') : f.expect;
    const problem = gradeAckRead(answered.value, expected);
    graded += 1;
    if (problem) failures.push(`read ${f.id}: ${problem}`);
  }

  for (const f of ACK_JUDGE_FIXTURES) {
    const window = {
      latestMinutes: f.latestMinutes,
      requireTime: f.requireTime,
      answerMayNotCome: f.answerMayNotCome === true,
    };
    const problems = await verdict(judge, f.line, window, ctx);
    const expected = broken ? (f.expect.length === 0 ? ['claims_done'] : []) : f.expect;
    const problem = gradeAckJudge(problems, expected);
    graded += 1;
    if (problem) failures.push(`judge ${f.id}: ${problem}`);
  }

  if (!broken) {
    for (const f of ACK_WRITER_FIXTURES) {
      const window = compose.draftWindow(f.draft);
      const rejected = [];
      let sent = null;
      for (let attempt = 0; attempt < compose.MAX_COMPOSE_ATTEMPTS && !sent; attempt += 1) {
        const request = await compose.ackDraftRequest(f.draft, rejected);
        const drafted = await call(request, `${NAME}:write:${f.id}:${attempt}`, ctx);
        const line = plainText(String(drafted.value?.line ?? ''));
        const problems = compose.mechanicalProblems(line, attempt);
        if (problems.length === 0) problems.push(...(await verdict(judge, line, window, ctx)));
        if (problems.length === 0) sent = line;
        else rejected.push({ line, problems });
      }
      graded += 1;
      if (!sent) {
        failures.push(
          `write ${f.id}: no sendable line (${rejected.map((r) => r.problems.join('+')).join(' | ')})`,
        );
      } else {
        console.log(`write ${f.id}: ${sent}`);
      }
    }
  }

  console.log(
    `${NAME} | ${mode} | graded=${graded} | failures=${failures.length} | $${totalUsd(ctx.cost).toFixed(4)} | live calls: ${ctx.cost.liveCalls}`,
  );
  for (const line of failures) console.error(line);
  if (broken) {
    const calibrated = failures.length === graded;
    console.log(
      `broken-mode calibration (every read and verdict must fail): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
    );
    process.exit(calibrated ? 0 : 1);
  }
  if (failures.length > 0) process.exit(1);
}

async function main() {
  const mode = parseEvalFlagsOrExit(NAME);
  if (mode === 'dry') {
    await dryRun();
    return;
  }
  await runJudged(mode);
}

main().catch((err) => {
  console.error(`${NAME} eval harness error:`, err);
  process.exit(1);
});
