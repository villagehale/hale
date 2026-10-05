// The connect-by-text door · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/connect-voice.md) run through the
// REAL request shape the handlers build. Nothing is replicated here: `connectLineInput`
// (apps/web/lib/channel/connect/line-input.ts) and the judge
// (apps/web/lib/channel/voice/judge.ts) are pure modules with relative imports only, so
// tsx loads them live. A change to the facts a kind hands over, to a red line, or to the
// skill re-keys the cache and shows up here as a miss rather than as silence.
//
// WHY THE BAR IS ZERO. Founder rule 2026-10-04: Hale never sends templated, canned, or
// fixed-fallback copy to a parent anywhere. This door used to BE a copy file (the offer
// with its "Good for 15 minutes", the fixed Google caution, three disconnect receipts;
// VIL-413 / VIL-417); now there is none underneath it. A line the judge refuses is
// retried once on a short prompt in production and then NOT SENT, with #ops paged. So a
// refused line here is a parent who asked for a link and got nothing.
//
// What is NOT tested here: the compose/retry/page machinery (spoken-line.test.ts), the
// per-kind facts and anchors (connect/line-input.test.ts), the minting, the revoke and the
// link appending (handlers, fresh-link and revoke tests, which inject a fake voice), and
// the reading of what the parent asked for (run-request-intent-eval.mjs). This eval is
// only about the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-connect-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-connect-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-connect-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · judge-refused lines — anything judgeSpokenLine refuses, by its reason: long, any
//     question, a missing account name / minutes / button word, a URL or phone (code
//     appends the real link; the model never writes one), compliance or keyword-reply
//     wording (the door's own `keyword_ask` red line covers CONNECT / LINK / CALENDAR in
//     either language), a claim about a password or about changing anything on Google's
//     side (`google_side_claim`), vous or an ASCII accent gap in French.
//   · one-template corpus — the offers opening the same way every time is the locked
//     sentence this change exists to remove.
// Everything else is the judge model's bar (JUDGE_MIN per fixture): the right line for
// the moment, in the friend voice, saying only what it was handed.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CONNECT_VOICE_FIXTURES } from './connect-voice-fixtures.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'connect-voice.md');
const JUDGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'voice', 'judge.ts');
const INPUT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'connect', 'line-input.ts');

/** Mirrors `lineJsonSchema` / MAX_TOKENS in apps/web/lib/channel/voice/spoken-line.ts. */
const LINE_TOOL_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
};
const MAX_TOKENS = 400;

/** How many distinct openings the offers must show between them. Low on purpose: it
 * catches a corpus collapsed onto one template without pretending to measure style. */
const MIN_DISTINCT_OFFER_OPENERS = 3;

const OFFER_KINDS = new Set(['offer', 'offer_both']);

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
  'You are a strict reviewer scoring ONE text message Hale sends a parent in their own',
  'thread about a Google account: handing over a connect link (one or two), or telling them',
  'how a disconnect went. Hale wrote it from the facts in the request and nothing else: no',
  'other knowledge of the family, no tools. When linkFollows is true, code appends the real',
  'URL on the next line, so the message points at "this link" and never writes one.',
  'You are given the request (kind, language, address, questions, mustMention, parentWords,',
  'linkFollows, the facts), the message, and watchFor - fixture-specific notes on what right',
  'and wrong look like for this moment. Score 1-5.',
  'A 5 reads like a friend who is good at this, texting one parent: short, plain, warm,',
  'first person, one or two sentences, saying exactly what the moment calls for and nothing',
  'more. There is never a question. Every string in mustMention appears word for word.',
  'In French a 5 uses tu with real accents, and says relier or lier rather than connecter.',
  'A LOW score is any of: a fact not in the request (a different account, a different',
  'number of minutes, a different button word, anything about what is in their account or',
  'what Hale will do with it); a URL, "http" or "www"; telling the parent to reply with a',
  'keyword or a word to type (CONNECT, LINK, YES, or any other); mentioning STOP or',
  'unsubscribing; claiming Hale saw a password, disconnected the account "from Google",',
  'told Google anything, or removed itself from their Google account; a question;',
  'exclamation marks, emoji, hype, "we" for Hale; a corporate or bot register; padding; a',
  'long apology; anything watchFor says must not happen.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: a keyword ask, an exclamation, a URL, an emoji, a
// Google-side claim and a question - trips the real judge on several reasons at once, so
// `--broken` proves the deterministic layer bites before the model judge does.
const BROKEN_LINE =
  "Reply CONNECT to link your Google Calendar! Or tap www.example.com 😊 I've removed Hale from Google for you - sound good?";

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { judgeSpokenLine, spokenLineContext } = await tsImport(JUDGE_SRC, import.meta.url);
  const { connectLineInput } = await tsImport(INPUT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'connect-voice', cachedOnly, getClient, cost);

  console.log(
    `connect-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${CONNECT_VOICE_FIXTURES.length} lines\n`);

  const results = [];
  for (const fixture of CONNECT_VOICE_FIXTURES) {
    const input = connectLineInput(fixture.request, fixture.language, fixture.options ?? {});
    const userMessage = JSON.stringify(spokenLineContext(input));
    const raw = broken
      ? BROKEN_LINE
      : (
          await cachedToolCall({
            tag: `connect-voice:${fixture.id}`,
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
  const offerOpeners = new Set(
    results.filter((r) => OFFER_KINDS.has(r.input.kind)).map((r) => opener(r.body)),
  );

  console.log('\n--- corpus metrics ---');
  console.log(
    `REFUSED LINES:           ${refused.length}  (0 required - there is no fallback sentence, so the parent hears nothing)`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(
    `distinct offer openings: ${offerOpeners.size}  (>= ${MIN_DISTINCT_OFFER_OPENERS} required - one template is the locked offer this replaces)`,
  );

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    results.every((r) => r.failures.length === 0) &&
    offerOpeners.size >= MIN_DISTINCT_OFFER_OPENERS;

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
  console.error('connect-voice eval harness error:', err);
  process.exit(2);
});
