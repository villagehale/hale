// The general-answer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL lane apps/web/lib/channel/off-domain/answer.ts runs, in its
// three phases: SANITIZE (general-answer-sanitize.md) takes the family out of the
// question and judges whether a correct answer needs something current, SEARCH
// (general-answer-search.md) is one streamed `web_search` turn on the de-identified
// question, and COMPOSE (general-answer.md) writes the reply. The request shapes are
// REPLICATED here rather than imported, for the reason the lane and medical evals
// replicate: that module sits behind the web app's `~/` alias, which the tsx loader here
// cannot resolve. The SKILL bodies and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows up
// here as a miss rather than as silence.
//
// The suite records with the search LIT, which is the lane as it works once
// GENERAL_ANSWER_SEARCH_ENABLED is on. Two fixtures (`searchOff`) run it dark, which is
// how it ships until then.
//
// What is NOT tested here: the lane routing (run-inbound-lane-eval.mjs); the flag, the
// named fallbacks, the link and health-line gates and the deterministic PII scrub under
// the sanitizer (apps/web/lib/channel/off-domain/answer.test.ts). The scrub sits behind
// `~/` and is not replicated, so the question this eval searches is the sanitizer's own.
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
// One check is not about the reply at all: what the fixture marks `mustNotReachSearch`
// must be gone from the de-identified question before it goes to the search (rule #1).
// It lives beside the field, in general-answer-fixtures.mjs (`identityLeaks`).
//
// CALIBRATION. Every run also puts one broken stand-in in front of the judge, on a
// searched fixture: a confident wrong result and a "check the app". A judge that passes
// it fails the suite. `--broken` prints that draw alone.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ANSWER_FIXTURES, EVAL_TODAY, identityLeaks } from './general-answer-fixtures.mjs';
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

// ── the lane's request shapes, replicated from answer.ts ────────────────────

const SEARCH_READINGS = ['yes', 'no', 'unsure', 'missing_detail'];

/** Mirrors `sanitizeJsonSchema` in answer.ts. */
const SANITIZE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string' },
    question: { type: 'string' },
    missing_detail: { type: 'string' },
    current_fact: { type: 'string' },
    needs_search: { type: 'string', enum: SEARCH_READINGS },
  },
  required: ['language', 'question', 'missing_detail', 'current_fact', 'needs_search'],
};

/** Mirrors `answerJsonSchema` in answer.ts. */
const ANSWER_TOOL_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};

/** Mirrors `questionSanitizeUserMessage` — the only call the parent's words reach. */
function questionSanitizeUserMessage(text) {
  return JSON.stringify({ text });
}

/** Mirrors `searchUserMessage`. */
function searchUserMessage({ question, today }) {
  return JSON.stringify({ question, today });
}

/** Mirrors `liveAsTold`. What the compose and the judge are both told about the search:
 * the three ways a needed search did not happen are one value. */
function liveOf(search) {
  if (search === 'searched' || search === 'not_needed' || search === 'missing_detail') {
    return search;
  }
  return 'unavailable';
}

/** Mirrors `generalAnswerUserMessage`. */
function generalAnswerUserMessage({ question, language, today, search, notes, missing }) {
  return JSON.stringify({
    question,
    language,
    today,
    live: liveOf(search),
    ...(search === 'searched' ? { research_notes: notes } : {}),
    ...(search === 'missing_detail' ? { missing } : {}),
  });
}

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

/** Mirrors `needsSearch`: only an explicit `no` skips the search. */
function needsSearch(raw) {
  return raw !== 'no';
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
  "about the parent's family, their kids or their plans.",
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
          visibleInput: (fixture) => questionSanitizeUserMessage(fixture.text),
        });

  console.log(
    `general-answer eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | sanitize=${sanitizeLane.model} search=${searchModel} compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${fixtures.length} questions | today: ${EVAL_TODAY}\n`);

  /** Phases 0 and 1 for one fixture: what the compose, and the judge, are handed. */
  async function research(fixture) {
    const sanitize = await cachedToolCall({
      tag: `general-answer-sanitize:${fixture.id}`,
      model: sanitizeLane.model,
      lane: sanitizeLane,
      system: sanitizeSkill.instructions,
      userMessage: questionSanitizeUserMessage(fixture.text),
      toolName: 'sanitize',
      toolSchema: SANITIZE_TOOL_SCHEMA,
      toolDescription: 'Return the de-identified question.',
      maxTokens: SANITIZE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const question = String(sanitize.value.question ?? '').trim();
    const language = normalizeLanguage(sanitize.value.language);
    const missing = String(sanitize.value.missing_detail ?? '').trim();

    let search = 'not_needed';
    let notes = '';
    let searchLatencyMs = 0;
    if (sanitize.value.needs_search === 'missing_detail') {
      search = 'missing_detail';
    } else if (needsSearch(sanitize.value.needs_search)) {
      if (fixture.searchOff) {
        search = 'search_off';
      } else {
        const found = await cachedSearch({
          tag: `general-answer-search:${fixture.id}`,
          model: searchModel,
          system: searchSkill.instructions,
          userMessage: searchUserMessage({ question, today: EVAL_TODAY }),
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
    }
    return {
      question,
      language,
      reading: String(sanitize.value.needs_search),
      search,
      notes,
      missing,
      latencyMs: sanitize.latencyMs + searchLatencyMs,
    };
  }

  /** What the judge reads: the parent's question, the reply, and the research. */
  function judgeInput(fixture, found, answer) {
    return {
      question: fixture.text,
      today: EVAL_TODAY,
      answer,
      live: liveOf(found.search),
      research_notes: found.search === 'searched' ? found.notes : 'none',
      watchFor: fixture.watchFor,
    };
  }

  // ── calibration: the judge on the broken stand-in ──────────────────────────
  const calibrationFixture = ANSWER_FIXTURES.find((fixture) => fixture.id === CALIBRATION_FIXTURE);
  const calibrationFound = await research(calibrationFixture);
  const calibration = await judge(
    `calibration:${calibrationFixture.id}`,
    judgeInput(calibrationFixture, calibrationFound, flatten(BROKEN_ANSWER)),
  );
  const calibrated = calibration.score < JUDGE_MIN;

  if (broken) {
    console.log('--- answers ---');
    console.log(
      `FAIL  ${calibrationFixture.id.padEnd(22)} [${calibrationFound.search}, judge ${calibration.score}] "${BROKEN_ANSWER}"`,
    );
    if (calibrated) console.log(`      · judge:${calibration.score} (${calibration.reason})`);
    console.log('\n--- gate ---');
    console.log(
      `broken-mode calibration (the judge must fail the stand-in): ${calibrated ? 'PASS (exit 0)' : `FAIL (exit 1) - the judge scored it ${calibration.score}`}`,
    );
    process.exit(calibrated ? 0 : 1);
  }

  const results = [];
  for (const fixture of fixtures) {
    const found = await research(fixture);
    // Rule #1, and not a check on the reply: what the fixture marks must be gone from
    // what leaves the sanitize stage, BEFORE any of it goes to the search.
    const failures = identityLeaks(fixture, `${found.question} ${found.missing}`);

    const composed = await cachedToolCall({
      tag: `general-answer:${fixture.id}`,
      model,
      lane: subjectLane,
      system: skill.instructions,
      userMessage: generalAnswerUserMessage({
        question: found.question,
        language: found.language,
        today: EVAL_TODAY,
        search: found.search,
        notes: found.notes,
        missing: found.missing,
      }),
      toolName: 'answer',
      toolSchema: ANSWER_TOOL_SCHEMA,
      toolDescription: 'Return the one brief answer to this question.',
      maxTokens: MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    const flattened = flatten(composed.value.answer);

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
      `${r.fixture.id.padEnd(22)} needs_search=${r.found.reading.padEnd(14)} ${r.found.language}  "${r.found.question}"${r.found.search === 'missing_detail' ? `  missing: "${r.found.missing}"` : ''}`,
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
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const count = (search) => results.filter((r) => r.found.search === search).length;
  const latency = (rows) => {
    const values = rows.map((r) => r.latencyMs);
    return `p50 ${percentile(values, 0.5)} ms / p95 ${percentile(values, 0.95)} ms over ${rows.length}`;
  };

  console.log('\n--- corpus metrics ---');
  console.log(`judge below ${JUDGE_MIN}:               ${judgeFails.length}  (0 required)`);
  console.log(
    `identity reached the search:  ${leaks.length}  (0 required - a marked name left in the de-identified question)`,
  );
  console.log(
    `judge on the broken stand-in: ${calibration.score}  (below ${JUDGE_MIN} required - a judge that passes it grades nothing)`,
  );
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
