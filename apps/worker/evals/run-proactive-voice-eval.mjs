// The proactive 1:1 voice · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/proactive-voice.md) run through the
// REAL request shape the nudge sweep builds. Nothing is replicated here:
// `proactiveLineInput` (apps/web/lib/channel/nudge/proactive-line.ts) and the judge
// (apps/web/lib/channel/voice/judge.ts) are pure modules with relative imports only, so
// tsx loads them live. A change to the facts a kind hands over, to a red line, or to the
// skill re-keys the cache and shows up here as a miss rather than as silence.
//
// WHY THE BAR IS ZERO. Founder rule 2026-10-04: Hale never sends templated, canned, or
// fixed-fallback copy to a parent anywhere. These two asks used to BE fixed sentences
// (VIL-360, VIL-365); now there is none underneath them. A line the judge refuses is
// retried once on a short prompt in production and then NOT SENT, with #ops paged. So a
// refused line here is a week the family hears nothing.
//
// What is NOT tested here: the compose/retry/page machinery (spoken-line.test.ts), the
// per-ask facts and anchors (proactive-line.test.ts), and the sweep's dedupe, gates and
// ledger (nudge/run.test.ts, which injects a fake voice). This eval is only about the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-proactive-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-proactive-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-proactive-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · judge-refused lines — anything judgeSpokenLine refuses, by its reason: long, not
//     exactly one question with the question last, a missing kid / day / label, an
//     invented time / weekday / price / URL / phone, compliance or keyword-reply wording,
//     vous in a 1:1 French ask or an ASCII accent gap, or a booking claim.
//   · one-template corpus — the asks (questions: 1) opening the same way
//     every time is the preset body this change exists to remove. A parent reads these
//     for months.
// Everything else is the judge model's bar (JUDGE_MIN per fixture): the right ask for the
// moment, in the friend voice, naming only what it was handed.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { PROACTIVE_VOICE_FIXTURES } from './proactive-voice-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'proactive-voice.md');
const JUDGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'voice', 'judge.ts');
const INPUT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'nudge', 'proactive-line.ts');

/** Same ceiling as MAX_TOKENS in apps/web/lib/channel/voice/spoken-line.ts. */
const MAX_TOKENS = 400;

/** How many distinct openings the asks must show between them. Low on purpose: it catches
 * a corpus collapsed onto one template without pretending to measure style. */
const MIN_DISTINCT_ASK_OPENERS = 3;

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
  'You are a strict reviewer scoring ONE unprompted text message Hale sends a parent about',
  'their kids week. Hale wrote it from the facts in the request and nothing else: no other',
  'knowledge of the family, no tools, no search results yet.',
  'You are given the request (kind, language, address, questions, mustMention, the facts),',
  'the message, and watchFor - fixture-specific notes on what right and wrong look like for',
  'this moment. Score 1-5.',
  'A 5 reads like a friend who is good at this, texting one parent: short, plain, warm,',
  'first person, one or two sentences, offering exactly what the moment calls for and',
  'nothing more. When questions is 1 there is exactly one question, it is the last',
  'sentence and it ends with a question mark; when questions is 0 there is no question',
  'at all (the travel_brief kind is an opening that code appends real finds after, so it',
  'leads into a list and asks nothing).',
  'In French a 5 uses tu when address is tu and vous when address is vous, with real accents.',
  'A LOW score is any of: a fact not in the request (a child name, activity, program, venue,',
  'time, date, weekday, place, price, weather); listing options Hale has not found yet;',
  'claiming Hale booked, registered, reserved, or signed anyone up; the wrong number of',
  'questions, or a question written as a statement;',
  'telling the parent to reply with a keyword, a number, YES or NO; mentioning STOP or',
  'unsubscribing; a URL; exclamation marks, emoji, hype, "we" for Hale; a corporate or bot',
  'register; padding; a judgement about the family having nothing planned; anything',
  'watchFor says must not happen.',
  'An offer to look is not a list of options. after_school, empty_saturday, and',
  'weekend_fallback have not found anything yet: "I can find one" / "je peux chercher" /',
  '"qui tourne vraiment" / "that\'s actually running" is the moment. empty_saturday names',
  'no activity, place, or time. Score down a named program, place, day, time, or price,',
  'not the offer to look. A weekday name in weekend_fallback (Saturday, Sunday, samedi,',
  'dimanche) is invented. The word "weekend" / "weekdays" is not.',
  '"ça t\'intéresse?" is a real question when it is the one question and it ends with ?.',
  'weekend_fallback must say the options just sent were weekend ones ("the weekend options',
  'I just sent" / "ce que je viens de t\'envoyer"). That sentence is the moment, not an',
  'invented fact. linkFollows false only forbids "this link" and a URL; it does not forbid',
  'referring to the weekend options Hale just sent.',
  'First person "I" / "je" is required. The ban is "we" / "on" / "nous", not first person.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: a booking claim, an invented weekday and time, an emoji,
// a keyword ask, a URL, and a second question - trips the real judge on several reasons
// at once, so `--broken` proves the deterministic layer bites before the model judge does.
const BROKEN_LINE =
  "Hi there! I've booked Maya into swim on Sunday at 10:30 😊 Reply YES to confirm? See www.example.com - sound good?";

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
  const { proactiveLineInput } = await tsImport(INPUT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'proactive-voice', cachedOnly, getClient, cost);

  console.log(
    `proactive-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${PROACTIVE_VOICE_FIXTURES.length} lines\n`);

  const results = [];
  for (const fixture of PROACTIVE_VOICE_FIXTURES) {
    const input = proactiveLineInput(fixture.request, fixture.language, fixture.address);
    const userMessage = JSON.stringify(spokenLineContext(input));
    const raw = broken
      ? BROKEN_LINE
      : assembleSpokenLine(
          input.questions,
          (
            await cachedToolCall({
              tag: `proactive-voice:${fixture.id}`,
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
    console.log(`${tag}  ${r.fixture.id.padEnd(26)} "${r.body.slice(0, 100)}"`);
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
    `distinct ask openings:   ${askOpeners.size}  (>= ${MIN_DISTINCT_ASK_OPENERS} required - one template is a preset body)`,
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
  console.error('proactive-voice eval harness error:', err);
  process.exit(2);
});
