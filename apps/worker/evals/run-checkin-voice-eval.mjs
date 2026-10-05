// The evening check-in voice · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/checkin-voice.md) run through the
// REAL request shape the sweep and the reply handler build. Nothing is replicated here:
// `checkInLineInput` (apps/web/lib/channel/checkin/line-input.ts) and the judge
// (apps/web/lib/channel/voice/judge.ts) are pure modules with relative imports only, so
// tsx loads them live. A change to the facts a kind hands over, to a red line, or to the
// skill re-keys the cache and shows up here as a miss rather than as silence.
//
// WHY THE BAR IS ZERO. Founder rule 2026-10-04: Hale never sends templated, canned, or
// fixed-fallback copy to a parent anywhere, and never asks a parent to reply with a
// keyword. This lane used to BE a copy file that taught LESS, NO and DAILY (VIL-413 /
// VIL-417); now there is none underneath it. A line the judge refuses is retried once on
// a short prompt in production and then NOT SENT, with #ops paged. So a refused line here
// is an evening the family hears nothing - and the nightly ask is the sentence a parent
// reads from Hale more than any other.
//
// What is NOT tested here: the compose/retry/page machinery (spoken-line.test.ts), the
// per-kind facts and anchors (line-input.test.ts), the sweep's dedupe, gates and ledger
// (sweep.test.ts, which injects a fake voice), and the reading of the parent's reply
// (run-checkin-intent-eval.mjs). This eval is only about the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-checkin-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-checkin-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-checkin-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · judge-refused lines — anything judgeSpokenLine refuses, by its reason: long, not
//     exactly one question with the question last on an ask or any question on an ack, a
//     missing kid / activity / parent name, an invented time / weekday / price / URL /
//     phone, compliance or keyword-reply wording (the lane's own `keyword_ask` red line
//     covers LESS / NO / DAILY in either language), a "Noted" opener, a remark on the
//     silence, tu/vous or an ASCII accent gap in French, or a booking claim.
//   · one-template corpus — the asks (questions: 1) opening the same way every time is
//     the preset pool this change exists to remove. A parent reads these for months.
// Everything else is the judge model's bar (JUDGE_MIN per fixture): the right line for
// the moment, in the friend voice, saying only what it was handed.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CHECKIN_VOICE_FIXTURES } from './checkin-voice-fixtures.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'checkin-voice.md');
const JUDGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'voice', 'judge.ts');
const INPUT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'checkin', 'line-input.ts');

/** Same ceiling as MAX_TOKENS in apps/web/lib/channel/voice/spoken-line.ts. */
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
  'You are a strict reviewer scoring ONE text message Hale sends a parent in its evening',
  'check-in lane: the nightly "how did today go" question, the same question anchored on an',
  'activity Hale saw on the calendar, a thank-you for a diary line the parent sent back, or',
  'a receipt that how often Hale asks has changed. Hale wrote it from the facts in the',
  'request and nothing else: no other knowledge of the family, no tools.',
  'You are given the request (kind, language, address, questions, mustMention, parentWords,',
  'the facts), the message, and watchFor - fixture-specific notes on what right and wrong',
  'look like for this moment. Score 1-5.',
  'A 5 reads like a friend who is good at this, texting one parent in the evening: short,',
  'plain, warm, first person, one or two sentences, asking or saying exactly what the moment',
  'calls for and nothing more. When questions is 1 there is exactly one question, it is the',
  'last sentence and it ends with a question mark; when questions is 0 there is no question',
  'at all. When address is vous the text lands in the household group, so it uses vous in',
  'French and opens by naming the parent in facts.parentName.',
  'In French a 5 uses tu when address is tu and vous when address is vous, with real accents.',
  'A LOW score is any of: a fact not in the request (a child name, an activity, a place, a',
  'time, a date, a weekday, a price, anything about how the day went); quoting, summarising',
  'or evaluating what the parent wrote in parentWords; telling the parent to reply with a',
  'keyword or a word to type (LESS, NO, DAILY, YES, or any other); mentioning STOP or',
  'unsubscribing; a URL; a "Noted" opener; a remark on a missed reply or a quiet evening;',
  'claiming Hale booked or registered anything; the wrong number of questions, or a',
  'question written as a statement; exclamation marks, emoji, hype, "we" for Hale; a',
  'corporate, survey or bot register; padding; anything watchFor says must not happen.',
  '"say so", "dis-le", "just say", and "say the word" without naming a word to type are the',
  'friend way out this lane asks for. They are not a keyword ask. A keyword ask names the',
  'word (YES, NO, STOP, LESS, DAILY) or tells them to type a specific token.',
  'Thanking the parent ("thanks for letting me know" / "merci") is the noted_ack moment.',
  'It is not a "Noted" opener. "Noted" means that word. Saying the note shapes what Hale',
  'looks for next weekend is the point, not a summary of parentWords, as long as the',
  "parent's words are not repeated.",
  'First person "I" / "je" is required. The ban is "we" / "on" / "nous", not first person.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: a "Noted" opener, an exclamation, an emoji, a keyword
// ask for LESS and NO, a URL, and a question that is not the last sentence - trips the
// real judge on several reasons at once, so `--broken` proves the deterministic layer
// bites before the model judge does.
const BROKEN_LINE =
  'Noted! How did today go with the kids? Reply LESS for weekly, or NO to skip these 😊 See www.example.com';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const {
    judgeSpokenLine,
    spokenLineContext,
    spokenLineToolSchema,
    spokenLineToolDescription,
    assembleSpokenLine,
  } = await tsImport(JUDGE_SRC, import.meta.url);
  const { checkInLineInput } = await tsImport(INPUT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'checkin-voice', cachedOnly, getClient, cost);

  console.log(
    `checkin-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${CHECKIN_VOICE_FIXTURES.length} lines\n`);

  const results = [];
  for (const fixture of CHECKIN_VOICE_FIXTURES) {
    const input = checkInLineInput(
      fixture.request,
      fixture.language,
      fixture.address,
      fixture.options ?? {},
    );
    const userMessage = JSON.stringify(spokenLineContext(input));
    const raw = broken
      ? BROKEN_LINE
      : assembleSpokenLine(
          input.questions,
          (
            await cachedToolCall({
              tag: `checkin-voice:${fixture.id}`,
              model,
              system: skill.instructions,
              userMessage,
              toolName: 'line',
              toolSchema: spokenLineToolSchema(input.questions),
              toolDescription: spokenLineToolDescription(input.questions),
              maxTokens: MAX_TOKENS,
              cachedOnly,
              getClient,
              cost,
            })
          ).value,
        );

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
    `REFUSED LINES:           ${refused.length}  (0 required - there is no fallback sentence, so the parent hears nothing)`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(
    `distinct ask openings:   ${askOpeners.size}  (>= ${MIN_DISTINCT_ASK_OPENERS} required - one template is the preset pool this replaces)`,
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
  console.error('checkin-voice eval harness error:', err);
  process.exit(2);
});
