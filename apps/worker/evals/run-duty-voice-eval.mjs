// The co-parent duty voice · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/duty-voice.md) run through the
// REAL request shape the sweep and the reply handler build. Nothing is replicated here:
// `dutyLineInput` (apps/web/lib/channel/coparent/duty/line-input.ts) and the judge
// (apps/web/lib/channel/voice/judge.ts) are pure modules with relative imports only, so
// tsx loads them live. A change to the facts a kind hands over, to a red line, or to the
// skill re-keys the cache and shows up here as a miss rather than as silence.
//
// WHY THE BAR IS ZERO. Founder rule 2026-10-04: Hale never sends templated, canned, or
// fixed-fallback copy to a parent anywhere. This lane used to BE a copy file: eleven
// locked templates in two languages (VIL-413 / VIL-417); now there is none underneath
// it. A line the judge refuses is retried once on a short prompt in production and then
// the whole bubble is NOT SENT, with #ops paged. So a refused line here is a Sunday the
// household hears nothing about the week, or a night-before reminder that never comes.
//
// What is NOT tested here: the compose/retry/page machinery (spoken-line.test.ts), the
// per-kind facts and anchors (duty/line-input.test.ts), the all-or-nothing bubble
// (duty/voice.test.ts), and the sweep's dedupe, gates and ledger (asks.pglite.test.ts,
// which injects a fake voice). This eval is only about the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-duty-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-duty-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-duty-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · judge-refused lines — anything judgeSpokenLine refuses, by its reason: long, not
//     exactly one question with the question last on an ask or any question elsewhere, a
//     missing name / event / day / time, an invented time / weekday / price / URL / phone,
//     compliance or keyword-reply wording (`keyword_ask`), a booking claim
//     (`booking_claim`), a scoreboard between the parents (`scorekeeping`: "your turn",
//     "as usual", "again this week"), Hale driving anyone (`hale_drives`), tu/vous the
//     wrong way round or an ASCII accent gap in French.
//   · one-template corpus — the asks (questions: 1) opening the same way every time is
//     the template pool this change exists to remove. A family reads these every week.
// Everything else is the judge model's bar (JUDGE_MIN per fixture): the right line for
// the moment, in the friend voice, saying only what it was handed.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { DUTY_VOICE_FIXTURES } from './duty-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'duty-voice.md');
const JUDGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'voice', 'judge.ts');
const INPUT_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'channel',
  'coparent',
  'duty',
  'line-input.ts',
);

/** Mirrors `lineJsonSchema` / MAX_TOKENS in apps/web/lib/channel/voice/spoken-line.ts. */
const LINE_TOOL_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
};
const MAX_TOKENS = 400;

/** How many distinct openings the asks must show between them. Low on purpose: it catches
 * a corpus collapsed onto one template without pretending to measure style. */
const MIN_DISTINCT_ASK_OPENERS = 4;

function normalizeForCompare(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first three words, as the cheap stand-in for "how this message opens". */
function opener(body) {
  return normalizeForCompare(body).split(' ').slice(0, 3).join(' ');
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sends into a household group',
  "chat - both parents of the same kids and Hale - about who has a kid's thing: the Sunday",
  'overview of the week, a reminder the night before, a nudge that nobody has claimed one',
  'yet, or an answer to a parent who just asked or just claimed one. Hale wrote it from the',
  'facts in the request and nothing else: no other knowledge of the family, no tools.',
  'You are given the request (kind, language, address, questions, mustMention, the facts),',
  'the message, and watchFor - fixture-specific notes on what right and wrong look like for',
  'this moment. Score 1-5.',
  'A 5 reads like a friend who is good at this, texting a couple: short, plain, warm, first',
  'person, one or two sentences (the week overview may run to four), saying or asking',
  'exactly what the moment calls for and nothing more. When questions is 1 there is exactly',
  'one question, it is the last sentence and it ends with a question mark; when questions',
  'is 0 there is no question at all. When address is vous both parents are spoken to; when',
  'address is tu the line is to the one parent named in facts.name, by name.',
  'In French a 5 uses tu when address is tu and vous when address is vous, with real accents.',
  'A LOW score is any of: a fact not in the request (a child name, an activity, a place, a',
  'time, a date, a weekday, who should take it); a null owner filled with a guess or a',
  'suggestion; telling the parent to reply with a keyword or a word to type (YES, NO, DONE,',
  'or any other); mentioning STOP or unsubscribing; a URL; "Noted", "I\'ll note it", "I\'ll',
  'keep track", "Text me if that changes"; any scoreboard between the parents - who does',
  'more, whose turn, "again", "as usual", fairness; blame or a sigh at nobody answering;',
  'Hale saying it will drive, take, pick up or drop off anyone, or that it booked or',
  'registered anything; the wrong number of questions, or a question written as a',
  'statement; exclamation marks, emoji, hype, "we" for Hale; a corporate, scheduler or bot',
  'register; padding; anything watchFor says must not happen.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: a scoreboard, a booking claim, Hale driving, a keyword
// ask, an exclamation, an emoji, a URL and a second question - trips the real judge on
// several reasons at once, so `--broken` proves the deterministic layer bites before the
// model judge does.
const BROKEN_LINE =
  "Your turn again this week! I've booked Maya into swim and I'll drive her 😊 Reply YES if that works? See www.example.com - ok?";

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { judgeSpokenLine, spokenLineContext } = await tsImport(JUDGE_SRC, import.meta.url);
  const { dutyLineInput } = await tsImport(INPUT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'duty-voice', cachedOnly, getClient, cost);

  console.log(
    `duty-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${DUTY_VOICE_FIXTURES.length} lines\n`);

  const results = [];
  for (const fixture of DUTY_VOICE_FIXTURES) {
    const input = dutyLineInput(fixture.request, fixture.language);
    const userMessage = JSON.stringify(spokenLineContext(input));
    const raw = broken
      ? BROKEN_LINE
      : (
          await cachedToolCall({
            tag: `duty-voice:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage,
            toolName: 'line',
            toolSchema: LINE_TOOL_SCHEMA,
            toolDescription: 'Return the one text message to send.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.line;

    const body = String(raw).trim();
    const failures = [];
    const judged = judgeSpokenLine(body, input);
    if (!judged.ok) failures.push(`refused:${judged.reason}`);

    const verdict = await judge(fixture.id, {
      request: userMessage,
      message: body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);

    results.push({ fixture, input, body, failures });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- lines ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(30)} "${r.body.slice(0, 100)}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const refused = results.filter((r) => r.failures.some((f) => f.startsWith('refused:')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const askOpeners = new Set(
    results.filter((r) => r.input.questions === 1).map((r) => opener(r.body)),
  );

  console.log('\n--- corpus metrics ---');
  console.log(
    `REFUSED LINES:           ${refused.length}  (0 required - there is no fallback sentence, so the household hears nothing)`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(
    `distinct ask openings:   ${askOpeners.size}  (>= ${MIN_DISTINCT_ASK_OPENERS} required - one template is the pool this replaces)`,
  );

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    results.every((r) => r.failures.length === 0) && askOpeners.size >= MIN_DISTINCT_ASK_OPENERS;

  console.log('\n--- gate ---');
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one gate): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('duty-voice eval harness error:', err);
  process.exit(2);
});
