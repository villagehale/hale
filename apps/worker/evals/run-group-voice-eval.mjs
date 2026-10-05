// The group voice · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/group-voice.md) run through the REAL
// request shape the web app builds. Unlike the older voice evals, nothing is replicated
// here: `groupLineInput` (apps/web/lib/channel/linq/group-line-input.ts) and the judge
// (apps/web/lib/channel/voice/judge.ts) are pure modules with relative imports only, so
// tsx loads them live. A change to the facts a kind hands over, to a red line, or to the
// skill re-keys the cache and shows up here as a miss rather than as silence.
//
// WHY THE BAR IS ZERO. Founder rule 2026-10-04: Hale never sends templated, canned, or
// fixed-fallback copy to a parent anywhere. In the group there is no fallback sentence
// underneath these lines. A line the judge refuses is retried once on a short prompt in
// production and then NOT SENT, with #ops paged. So a refused line here is not a degraded
// message, it is two parents hearing nothing.
//
// What is NOT tested here: the compose/retry/page machinery (spoken-line.test.ts), the
// per-kind facts and anchors (group-voice.test.ts), and every send path's dedupe, gates
// and ledger (the pglite tests, which inject a fake voice). This eval is only about the
// words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-group-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-group-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-group-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · judge-refused lines — anything judgeSpokenLine refuses, by its reason: long, the
//     wrong number of questions, a missing anchor, an invented time / weekday / price /
//     URL / phone, compliance or keyword-reply wording, tu in the group or an ASCII accent
//     gap in French, "this link" with no link following, or a booking claim.
//   · one-template corpus — the asks (questions: 1) all opening the same way. Two parents
//     read these for months; the variation the model is here for has to be visible across
//     the corpus, not just absent from any single line.
// Everything else is the judge model's bar (JUDGE_MIN per fixture): the right line for the
// moment, in the friend voice, to both parents unless the moment is about one of them.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { GROUP_VOICE_FIXTURES } from './group-voice-fixtures.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'group-voice.md');
const JUDGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'voice', 'judge.ts');
const INPUT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'linq', 'group-line-input.ts');

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
  'You are a strict reviewer scoring ONE text message Hale posts in a family group chat',
  'that holds both parents of the same kids and Hale. Hale wrote it from the facts in the',
  'request and nothing else: no other knowledge of the family, no tools.',
  'You are given the request (kind, language, address, questions, mustMention, the facts,',
  'and what the parent just said if anything), the message, and watchFor - fixture-specific',
  'notes on what right and wrong look like for this moment. Score 1-5.',
  'A 5 reads like a friend who is good at this, texting both parents: short, plain, warm,',
  'first person, two or three sentences at most, saying exactly what the moment calls for',
  'and nothing more, addressing the named parent when the moment is about one of them and',
  'both otherwise, with exactly the asked number of questions and the question last.',
  'In French a 5 uses vous (or tu only when address is tu) and real accents.',
  'A LOW score is any of: a fact not in the request (a name, activity, time, day, place,',
  'price, count); guessing who is reading, travelling, busy, or said yes; claiming Hale',
  'booked, registered, reserved, or signed anyone up; a second question; telling anyone to',
  'reply with a keyword, a number, YES or NO; mentioning STOP or unsubscribing; a URL;',
  'quoting anything from a mailbox; exclamation marks, emoji, hype, "we" for Hale; a',
  'corporate or bot register; padding; anything watchFor says must not happen.',
  'Do not invent bans the request does not make. First person "I" / "je" is the required',
  'voice; the ban is "we" / "on" / "nous" for Hale, not first person, and not Hale saying',
  "it will keep the kids' things straight across both calendars when that is the receipt.",
  'When linkFollows is true, "this link" / "ce lien" points at the URL code appends after',
  'the text. It is not a URL. A URL is an http address, www, or a pasted link. "Must not',
  'write a URL" means that, so a line that says "this link" with linkFollows true is right.',
  '"the kids\' year" / "l\'année des enfants" is the name of this thread when the moment is',
  'about it, not invented jargon. "I am still here" / "je suis toujours là" is the departure',
  'line when the register matches address (toi when tu, vous when vous), not padding.',
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
  const { groupLineInput } = await tsImport(INPUT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'group-voice', cachedOnly, getClient, cost);

  console.log(
    `group-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${GROUP_VOICE_FIXTURES.length} lines\n`);

  const results = [];
  for (const fixture of GROUP_VOICE_FIXTURES) {
    const input = groupLineInput(fixture.request, fixture.language, {
      parentWords: fixture.parentWords ?? null,
    });
    const userMessage = JSON.stringify(spokenLineContext(input));
    const raw = broken
      ? BROKEN_LINE
      : assembleSpokenLine(
          input.questions,
          (
            await cachedToolCall({
              tag: `group-voice:${fixture.id}`,
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
    `REFUSED LINES:           ${refused.length}  (0 required - there is no fallback sentence, so both parents hear nothing)`,
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
  console.error('group-voice eval harness error:', err);
  process.exit(2);
});
