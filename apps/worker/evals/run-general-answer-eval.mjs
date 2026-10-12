// The general-answer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL lane apps/web/lib/channel/off-domain/answer.ts runs, in its
// three phases: SANITIZE (general-answer-sanitize.md) takes the family out of the
// question and judges whether a correct answer needs something current, SEARCH
// (general-answer-search.md) is one streamed `web_search` turn on the de-identified
// question, and COMPOSE (general-answer.md) writes the reply. The REQUESTS are production's
// own: the three payloads, the two tool schemas, the readings and the identifier scrub
// are loaded from apps/web/lib/channel/off-domain/answer-request.ts, which imports
// nothing from behind the web app's `~/` alias so that this loader can read it. What the
// lane does around them (the client seam, the gates) does sit behind `~/` and is
// replicated below. The SKILL bodies and the model routing are imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows up
// here as a miss rather than as silence.
//
// The suite records with the search LIT, which is the lane as it works once
// GENERAL_ANSWER_SEARCH_ENABLED is on. The `searchOff` fixtures run it dark, which is how
// it ships until then.
//
// What is NOT tested here: the lane routing (run-inbound-lane-eval.mjs); the flag, the
// named fallbacks, the link and health-line gates, and where the family's place and a
// pending ask are read from (apps/web/lib/channel/off-domain/*.test.ts).
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-general-answer-eval.mjs            # live, then caches
//   node evals/run-general-answer-eval.mjs --cached-only                    # CI: replay only
//   node evals/run-general-answer-eval.mjs --broken --cached-only           # calibration
//   ... --min-samples=50                                                    # expanded synthetic corpus
//
// THE GRADER IS THE JUDGE (Barton, 2026-10-12: correctness and tone, with no word or
// length checks). It reads the question, the reply, and the research the search returned
// in that recorded turn, and scores one thing a pattern cannot: whether the reply is
// right. JUDGE_MIN per fixture.
//
// Three checks are not about the reply at all. What the fixture marks
// `mustNotReachSearch` must be gone from everything handed on to the search and the
// compose (rule #1); it lives beside the field, in general-answer-fixtures.mjs
// (`identityLeaks`). What it marks `mustReachSearch` (the town a parent named) must be in
// the request the search was sent (`searchOmissions`). And a fixture that hands the
// sanitizer a pending ask says whether the text completes it (`expectAnswersPending`),
// which is the sanitizer's own reading.
//
// CALIBRATION. Every run also puts two stand-ins in front of the judge, on a searched
// fixture. The broken one is a confident wrong result and a "check the app". The near
// miss is the suite's own correct reply to that fixture with an assistant's sign-off
// added. A judge that passes either fails the suite. `--broken` prints those two draws
// alone.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  ANSWER_FIXTURES,
  EVAL_TODAY,
  identityLeaks,
  searchOmissions,
} from './general-answer-fixtures.mjs';
import {
  JUDGE_MIN,
  cacheGet,
  cacheKey,
  cachePut,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  noteUsage,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { expandSyntheticFixtures } from './lib/model-matrix-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILLS = join(REPO_ROOT, 'packages', 'agent', 'skills');
const SANITIZE_SKILL_PATH = join(SKILLS, 'general-answer-sanitize.md');
const SEARCH_SKILL_PATH = join(SKILLS, 'general-answer-search.md');
const SKILL_PATH = join(SKILLS, 'general-answer.md');
/** Production's own request shapes (see the header). */
const ANSWER_REQUEST_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'off-domain',
  'answer-request.ts',
);

// ── what the lane does around its requests, replicated from answer.ts ───────

const MAX_SEARCHES = 2;
const SANITIZE_MAX_TOKENS = 512;
const SEARCH_MAX_TOKENS = 4096;
/** Mirrors `MAX_TOKENS` in answer.ts: the medical compose's budget. */
const MAX_TOKENS = 1024;

/** Mirrors `normalizeLanguage` in medical.ts, which answer.ts reuses. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;
function normalizeLanguage(raw) {
  const code = typeof raw === 'string' ? raw.trim() : '';
  return LANGUAGE_CODE.test(code) ? code : 'en';
}

/** Mirrors `readSearch`: an errored search block carries an object, not a list. */
function readSearch(content) {
  const urls = [];
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) urls.push(result.url);
  }
  const notes = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  return { urls, notes };
}

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts (behind `~/`, so replicated). */
const GSM7_SUBSTITUTIONS = [
  [/[‘’‛]/g, "'"],
  [/[“”]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[•·]/g, ''],
];

function flatten(text) {
  let out = text;
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/gm, '');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');
  for (const [pattern, replacement] of GSM7_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ── the search turn, recorded ────────────────────────────────────────────────

/** List price of one web search request, USD, billed apart from tokens: $10 per 1,000
 * searches (platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool, read
 * 2026-10-12). */
const USD_PER_WEB_SEARCH = 0.01;

/**
 * One STREAMED web_search turn, as answer.ts sends it, replayed from cache after. The
 * recording keeps what production reads off the turn (the result URLs, the notes and how
 * the turn stopped) and what the PR has to report (how many searches were billed, how
 * long it took).
 */
async function cachedSearch({ tag, model, system, userMessage, cachedOnly, getClient, cost }) {
  const canonical = JSON.stringify({
    model,
    system,
    userMessage,
    tool: 'web_search_20250305',
    maxUses: MAX_SEARCHES,
  });
  const key = cacheKey(tag, canonical);
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (cachedOnly) {
    console.error(
      `cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
    );
    process.exit(1);
  }
  const startedAt = Date.now();
  const response = await getClient()
    .messages.stream({
      model,
      max_tokens: SEARCH_MAX_TOKENS,
      system,
      tools: [{ name: 'web_search', type: 'web_search_20250305', max_uses: MAX_SEARCHES }],
      messages: [{ role: 'user', content: userMessage }],
    })
    .finalMessage();
  const latencyMs = Date.now() - startedAt;
  noteUsage(cost, model, response.usage);
  const searchRequests = response.usage.server_tool_use?.web_search_requests ?? 0;
  cost.webSearchRequests = (cost.webSearchRequests ?? 0) + searchRequests;
  cost.searchTurns = (cost.searchTurns ?? 0) + 1;
  cost.searchInput = (cost.searchInput ?? 0) + response.usage.input_tokens;
  cost.searchOutput = (cost.searchOutput ?? 0) + response.usage.output_tokens;
  const value = {
    ...readSearch(response.content),
    stopReason: response.stop_reason,
    searchRequests,
    latencyMs,
  };
  await cachePut(key, value);
  return value;
}

// ── the judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sends back to a parent who',
  'texted an off-topic question: a score, the weather, where something streams, a price,',
  "trivia, an opinion ask. Hale is a planner for kids' activities. Asked something",
  'off-topic, it answers the way a well-informed friend would text back.',
  'You are given the question, today (the date where the parent is), the answer, live,',
  'research_notes and watchFor (fixture-specific notes on what a right answer is).',
  'Score 1-5 on TWO things and nothing else: is the answer CORRECT, and does it sound',
  'like a FRIEND TEXTING.',
  'CORRECT depends on live. When live is "searched", a web search was made for this',
  'question and research_notes is what it returned: judge every current fact in the',
  'answer against research_notes and NOT against your own memory, which has a cutoff the',
  'notes are newer than. A current fact the notes do not support, or one that contradicts',
  'them, is wrong, however plausible. When live is "not_needed", no search was needed:',
  'judge the answer as settled knowledge, arithmetic, an honest opinion or a creative',
  'ask. When live is "unavailable", no search could be made this time: the correct answer',
  'says plainly that it cannot check that right now, and states no current fact from',
  'memory. When live is "missing_detail", the question left out something its answer',
  'depends on (which city, which country) and no search was made: the correct answer',
  'asks for it in a few words, and states no current fact from memory.',
  'A FRIEND TEXTING is brief and casual, in the language the question was asked in, and',
  'it IS the answer: an opinion ask gets a real pick, a fact gets stated. A reply that',
  'deflects, tells the parent to look it up or go and check somewhere, or points at an',
  'app in place of answering, is not an answer. On a health question, pointing to a',
  'pharmacist or a doctor is a safety judgment and not a deflect. Saying which detail is',
  'needed (which city) when the question left it out is an answer, not a deflect.',
  'A LOW score is any of: a wrong or unsupported fact; an invented specific; a deflect',
  'or a look-it-up; an answer in a different language from the question; anything stated',
  "about the parent's family, their kids or their plans; a reply that reads like an",
  'assistant offering a service, rather than a friend texting back, which scores below 4',
  'however right its facts are.',
  'Do not score length, in sentences or characters. Do not mark emoji up or down.',
  'Reply with ONLY the score tool.',
].join(' ');

/** The searched fixture the broken stand-in is graded on. */
const CALIBRATION_FIXTURE = 'leafs-last-night';

// The calibration stand-in: a result stated with total confidence that no search
// returned, then the app, a link and a question handed back. Graded by the real judge
// against the research that fixture's search did return.
const BROKEN_ANSWER =
  'The Leafs won 9-0 last night, no question about it. Check the app or https://example.com for the details, ok?';

// The near miss: put after the suite's own reply to the calibration fixture, so the facts
// are the right ones and the only thing wrong is that it reads like an assistant signing
// off rather than a friend texting. A judge that passes it has no floor under tone.
const NEAR_MISS_TAIL = 'Want me to check anything else for you?';

/** Nearest-rank percentile over whole-millisecond latencies. */
function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1];
}

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const minSamplesArg = process.argv.find((arg) => arg.startsWith('--min-samples='))?.split('=')[1];
  const minSamples = minSamplesArg === undefined ? null : Number(minSamplesArg);
  if (minSamples !== null && (!Number.isInteger(minSamples) || minSamples < 1)) {
    throw new Error('--min-samples must be a positive integer');
  }
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const request = await tsImport(ANSWER_REQUEST_SRC, import.meta.url);
  const sanitizeSkill = await agent.loadSkill(SANITIZE_SKILL_PATH);
  const searchSkill = await agent.loadSkill(SEARCH_SKILL_PATH);
  const skill = await agent.loadSkill(SKILL_PATH);
  const sanitizeLane = agent.pickLane(sanitizeSkill.meta.task);
  const searchModel = agent.pickModel(searchSkill.meta.task);
  const model = agent.pickModel(skill.meta.task);
  const subjectLane = agent.pickLane(skill.meta.task);
  // The rubric-holding tier: this judge has to hold a fact in the answer to the research
  // notes, which is the judgment the whole suite rests on.
  const judgeModel = await readJudgeModel('sonnet');
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'general-answer', cachedOnly, getClient, cost);
  const fixtures =
    minSamples === null
      ? ANSWER_FIXTURES
      : expandSyntheticFixtures('general-answer', ANSWER_FIXTURES, minSamples, {
          vary: (fixture, { reference }) => {
            fixture.text += `\n[message ${reference}]`;
          },
          visibleInput: (fixture) => request.questionSanitizeUserMessage(fixture.text),
        });

  console.log(
    `general-answer eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | sanitize=${sanitizeLane.model} search=${searchModel} compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${fixtures.length} questions | today: ${EVAL_TODAY}\n`);

  /**
   * Phases 0 and 1 for one fixture, as answer.ts runs them: what the compose, and the
   * judge, are handed. `fixture.place` is what the lane's place read would return for
   * this family, `fixture.pending` the question Hale's last reply left open, and
   * `fixture.research` a search result supplied by the fixture in place of a live one.
   */
  async function research(fixture, pending = fixture.pending ?? null) {
    const sanitize = await cachedToolCall({
      tag: `general-answer-sanitize:${fixture.id}`,
      model: sanitizeLane.model,
      lane: sanitizeLane,
      system: sanitizeSkill.instructions,
      userMessage: request.questionSanitizeUserMessage(fixture.text, pending),
      toolName: 'sanitize',
      toolSchema: request.sanitizeJsonSchema,
      toolDescription: 'Return the de-identified question.',
      maxTokens: SANITIZE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    // A text the sanitizer does not read as the reply to the pending ask is handed back
    // to the lane, which routes it from the top: here, sanitized again on its own.
    const answersPending =
      pending === null ? null : request.answersPending(sanitize.value.answers_pending);
    if (answersPending === false) {
      const alone = await research(fixture, null);
      return { ...alone, answersPending, latencyMs: alone.latencyMs + sanitize.latencyMs };
    }

    // The deterministic scrub under the sanitizer, before anything is handed on.
    const question = request.scrubDirectIdentifiers(String(sanitize.value.question ?? '').trim());
    const missing = request.scrubDirectIdentifiers(
      String(sanitize.value.missing_detail ?? '').trim(),
    );
    const language = normalizeLanguage(sanitize.value.language);
    const lit = !fixture.searchOff;
    const searching = request.needsSearch(sanitize.value.needs_search);
    const place =
      lit && searching && request.turnsOnTheirPlace(sanitize.value.their_place)
        ? (fixture.place ?? null)
        : null;

    let search = 'not_needed';
    let notes = '';
    let searchMessage = '';
    let searchLatencyMs = 0;
    if (fixture.research !== undefined) {
      // A supplied search result is the fixture's whole point, so the turn is taken as
      // searched whatever the sanitizer read.
      search = 'searched';
      notes = fixture.research.notes;
    } else if (!searching) {
      search = 'not_needed';
    } else if (lit && sanitize.value.needs_search === 'missing_detail' && place === null) {
      search = 'missing_detail';
    } else if (!lit) {
      search = 'search_off';
    } else {
      searchMessage = request.searchUserMessage({ question, today: EVAL_TODAY, place });
      const found = await cachedSearch({
        tag: `general-answer-search:${fixture.id}`,
        model: searchModel,
        system: searchSkill.instructions,
        userMessage: searchMessage,
        cachedOnly,
        getClient,
        cost,
      });
      searchLatencyMs = found.latencyMs;
      // Mirrors `liveSearch`: a turn that did not finish is not research either.
      if (found.stopReason !== 'end_turn' || found.urls.length === 0 || found.notes === '') {
        search = 'nothing_usable';
      } else {
        search = 'searched';
        notes = found.notes;
      }
    }
    return {
      question,
      language,
      reading: String(sanitize.value.needs_search),
      theirPlace: String(sanitize.value.their_place),
      answersPending,
      placeSent: searchMessage !== '' && place !== null,
      search,
      notes,
      missing,
      searchMessage,
      latencyMs: sanitize.latencyMs + searchLatencyMs,
    };
  }

  /** Phase 2 for one fixture: the reply, flattened as production flattens it. */
  async function compose(fixture, found) {
    const composed = await cachedToolCall({
      tag: `general-answer:${fixture.id}`,
      model,
      lane: subjectLane,
      system: skill.instructions,
      userMessage: request.generalAnswerUserMessage({
        question: found.question,
        language: found.language,
        today: EVAL_TODAY,
        search: found.search,
        notes: found.notes,
        missing: found.missing,
      }),
      toolName: 'answer',
      toolSchema: request.answerJsonSchema,
      toolDescription: 'Return the one brief answer to this question.',
      maxTokens: MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    return { flattened: flatten(composed.value.answer), latencyMs: composed.latencyMs };
  }

  /** What the judge reads: the parent's question, the reply, and the research. */
  function judgeInput(fixture, found, answer) {
    return {
      question: fixture.text,
      today: EVAL_TODAY,
      answer,
      live: request.liveAsTold(found.search),
      research_notes: found.search === 'searched' ? found.notes : 'none',
      watchFor: fixture.watchFor,
    };
  }

  // ── calibration: the judge on the two stand-ins ────────────────────────────
  const calibrationFixture = ANSWER_FIXTURES.find((fixture) => fixture.id === CALIBRATION_FIXTURE);
  const calibrationFound = await research(calibrationFixture);
  const calibration = await judge(
    `calibration:${calibrationFixture.id}`,
    judgeInput(calibrationFixture, calibrationFound, flatten(BROKEN_ANSWER)),
  );
  const nearMissAnswer = `${(await compose(calibrationFixture, calibrationFound)).flattened} ${NEAR_MISS_TAIL}`;
  const nearMiss = await judge(
    `calibration-near-miss:${calibrationFixture.id}`,
    judgeInput(calibrationFixture, calibrationFound, nearMissAnswer),
  );
  const calibrated = calibration.score < JUDGE_MIN && nearMiss.score < JUDGE_MIN;

  if (broken) {
    console.log('--- answers ---');
    for (const [id, answer, verdict] of [
      [calibrationFixture.id, BROKEN_ANSWER, calibration],
      [`${calibrationFixture.id}:near-miss`, nearMissAnswer, nearMiss],
    ]) {
      console.log(
        `${verdict.score < JUDGE_MIN ? 'FAIL' : 'PASS'}  ${id.padEnd(28)} [${calibrationFound.search}, judge ${verdict.score}] "${answer}"`,
      );
      console.log(`      · judge:${verdict.score} (${verdict.reason})`);
    }
    console.log('\n--- gate ---');
    console.log(
      `broken-mode calibration (the judge must fail both stand-ins): ${calibrated ? 'PASS (exit 0)' : `FAIL (exit 1) - the judge scored the broken one ${calibration.score} and the near miss ${nearMiss.score}`}`,
    );
    process.exit(calibrated ? 0 : 1);
  }

  const results = [];
  for (const fixture of fixtures) {
    const found = await research(fixture);
    // Rule #1, and not a check on the reply: what the fixture marks must be gone from
    // everything handed on, BEFORE any of it goes to the search or the compose.
    const failures = identityLeaks(
      fixture,
      `${found.question} ${found.missing} ${found.searchMessage}`,
    );
    // The town the parent named is what the search is made for.
    failures.push(...searchOmissions(fixture, found.searchMessage));
    // The sanitizer's own reading of a text beside a pending ask, not a check on the reply.
    if (
      fixture.expectAnswersPending !== undefined &&
      found.answersPending !== fixture.expectAnswersPending
    ) {
      failures.push(
        `pending_misread:read as ${found.answersPending ? 'the reply to the pending ask' : 'unrelated'}`,
      );
    }

    const composed = await compose(fixture, found);
    const flattened = composed.flattened;

    const verdict = await judge(fixture.id, judgeInput(fixture, found, flattened));
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);

    results.push({
      fixture,
      found,
      flattened,
      score: verdict.score,
      failures,
      latencyMs: found.latencyMs + composed.latencyMs,
    });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  // What left the sanitize stage for the search and the compose, beside its reading.
  console.log('--- de-identified questions ---');
  for (const r of results) {
    console.log(
      `${r.fixture.id.padEnd(22)} needs_search=${r.found.reading.padEnd(14)} their_place=${r.found.theirPlace.padEnd(10)} ${r.found.language}  "${r.found.question}"${r.found.search === 'missing_detail' ? `  missing: "${r.found.missing}"` : ''}${r.found.placeSent ? '  [searched with the family place]' : ''}${r.found.answersPending === null ? '' : `  [pending ask: ${r.found.answersPending ? 'completed' : 'unrelated'}]`}`,
    );
  }

  console.log('\n--- answers ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${tag}  ${r.fixture.id.padEnd(22)} [${r.found.search}, judge ${r.score}, ${r.latencyMs} ms] "${r.flattened}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const leaks = results.filter((r) => r.failures.some((f) => f.startsWith('identity_leak:')));
  const omissions = results.filter((r) =>
    r.failures.some((f) => f.startsWith('not_sent_to_search:')),
  );
  const misreads = results.filter((r) => r.failures.some((f) => f.startsWith('pending_misread:')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const count = (search) => results.filter((r) => r.found.search === search).length;
  const latency = (rows) => {
    const values = rows.map((r) => r.latencyMs);
    return `p50 ${percentile(values, 0.5)} ms / p95 ${percentile(values, 0.95)} ms over ${rows.length}`;
  };

  console.log('\n--- corpus metrics ---');
  console.log(`judge below ${JUDGE_MIN}:               ${judgeFails.length}  (0 required)`);
  console.log(
    `identity reached the search:  ${leaks.length}  (0 required - a marked name left in what was handed on)`,
  );
  console.log(
    `named town not searched:      ${omissions.length}  (0 required - a town the parent named, left out of the search)`,
  );
  console.log(
    `pending ask misread:          ${misreads.length}  (0 required - a reply read as a new question, or the reverse)`,
  );
  console.log(
    `judge on the broken stand-in: ${calibration.score}  (below ${JUDGE_MIN} required - a judge that passes it grades nothing)`,
  );
  console.log(
    `judge on the near miss:       ${nearMiss.score}  (below ${JUDGE_MIN} required - a judge that passes it has no floor under tone)`,
  );
  if (nearMiss.score >= JUDGE_MIN)
    console.log(`      · judge:${nearMiss.score} (${nearMiss.reason})`);
  console.log(
    `live search:                  ${count('searched')} searched, ${count('not_needed')} not needed, ${count('missing_detail')} missing a detail, ${count('search_off')} dark, ${count('nothing_usable')} nothing usable`,
  );
  console.log(
    `latency, searched answer:     ${latency(results.filter((r) => r.found.search === 'searched'))}  (sanitize + search + compose)`,
  );
  console.log(
    `latency, unsearched answer:   ${latency(results.filter((r) => r.found.search !== 'searched'))}  (sanitize + compose)`,
  );

  const webSearchRequests = cost.webSearchRequests ?? 0;
  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );
  console.log(
    `web search requests this run: ${webSearchRequests} | fee, billed apart from tokens: $${(webSearchRequests * USD_PER_WEB_SEARCH).toFixed(2)} USD`,
  );
  for (const [name, bucket] of Object.entries(cost.byModel)) {
    console.log(`tokens this run, ${name}: ${bucket.input} in / ${bucket.output} out`);
  }
  console.log(
    `of which search turns: ${cost.searchTurns ?? 0} calls, ${cost.searchInput ?? 0} in / ${cost.searchOutput ?? 0} out`,
  );

  const allPass = calibrated && results.every((r) => r.failures.length === 0);

  console.log('\n--- gate ---');
  console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('general-answer eval harness error:', err);
  process.exit(2);
});
