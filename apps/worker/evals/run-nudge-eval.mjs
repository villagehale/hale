// VIL-239 · M4 proactive-nudge composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/nudge-voice.md) run through the
// REAL request shape the sweep builds. Since VIL-413 / VIL-417 nothing is replicated here:
// `nudgeLineInput` (apps/web/lib/channel/nudge/nudge-line-input.ts) and the judge
// (apps/web/lib/channel/voice/judge.ts) are pure modules with relative imports only, so
// tsx loads them live. A change to the facts a kind hands over, to a red line, or to the
// skill re-keys the cache and shows up here as a miss rather than as silence.
//
// WHY THE BAR IS ZERO. Founder rule 2026-10-04: Hale never sends templated, canned, or
// fixed-fallback copy to a parent anywhere. The find nudges used to have a deterministic
// render underneath them ("an on-time plain sentence beats silence"); that render is
// gone. A line the judge refuses is retried once on a short prompt in production and then
// NOT SENT, with #ops paged. So a refused line here is a week the family hears nothing.
//
// What is NOT tested here: the selector and the outbound gate (apps/web/lib/channel/nudge/
// nudge-decide.test.ts, outbound-gate.test.ts — pure code, no model), the compose/retry/
// page machinery (voice/spoken-line.test.ts), and the per-kind facts and anchors
// (nudge-voice.test.ts). This eval is about the one thing a model does in M4: turning a
// decision into an UNSOLICITED text message without inventing anything. The stakes differ
// from a reply's by one fact: nobody asked for this message, so there is no question it
// was answering to correct a plausible invention.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-nudge-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-nudge-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-nudge-eval.mjs --cached-only                    # CI: replay only
//   ... --only=<fixture id>                                        # one fixture
//
// THE HARD ZEROS:
//   · judge-refused lines — anything judgeSpokenLine refuses, by its reason: long, any
//     question, a missing anchor (the title, the day, a kid), an invented time / weekday /
//     price / URL / phone, compliance or keyword-reply wording, the wrong French register
//     or an ASCII accent gap, a booking claim, or urgency Hale was not given.
//   · forbidden words — the fixture's own fabrication list (rain on a cold forecast, a
//     weekend on a weekday find), checked outside the fact slots.
// Everything else is the judge model's bar (JUDGE_MIN per fixture): the right line for the
// moment, quiet and specific, earning the interruption.

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
import { NUDGE_FIXTURES, NUDGE_OPT_OUT } from './nudge-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'nudge-voice.md');
const JUDGE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'voice', 'judge.ts');
const INPUT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'nudge', 'nudge-line-input.ts');

/** Mirrors `lineJsonSchema` / MAX_TOKENS in apps/web/lib/channel/voice/spoken-line.ts. */
const LINE_TOOL_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
};
const MAX_TOKENS = 400;

/** The skill's own ceiling, restated as a sentence count the judge cannot see. */
const MAX_SENTENCES = 2;

function countSentences(message) {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

/** Fixture-listed words that mean the model reached past its facts, checked outside the slots. */
function forbiddenHits(body, fixture, slots) {
  let outside = body.toLowerCase();
  for (const slot of slots) outside = outside.split(slot.toLowerCase()).join(' ');
  return (fixture.forbidden ?? []).filter((word) => outside.includes(word.toLowerCase()));
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring an UNSOLICITED text message Hale sends a parent.',
  'Nobody asked for it; the phone just buzzed. You are given the request (kind, language,',
  'address, mustMention, and the FACTS Hale decided on), the message written from them,',
  'and watchFor - fixture-specific notes on what right and wrong look like.',
  'Score VOICE & FAITHFULNESS on a 1-5 integer scale. A 5 earns the interruption: quiet,',
  'plain-spoken, specific, ONE thing, at most two short sentences, first person, and it',
  'states only the given facts. Two shapes are both correct and are scored the same way.',
  'When the facts carry a DEADLINE (a registration date), the message leads with it. When',
  'they carry a WEEKEND SUGGESTION, there is no deadline to lead with: leading with the',
  'forecast and then naming the thing it points to is exactly right, and must not be',
  'marked down for lacking urgency it was never given.',
  'In French a 5 uses tu when address is tu and vous when address is vous, with real accents.',
  'A LOW score is hype or exclamation marks, brand/corporate voice ("We are excited to"),',
  'apologising for texting or explaining why it is texting ("just a quick heads up"),',
  'reciting the facts like a database row, asking a question, sounding like an ad,',
  'inventing urgency or advice, claiming Hale booked or registered anything, mentioning',
  'STOP or unsubscribing, or any detail not present in the facts; anything watchFor says',
  'must not happen.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: invents a venue, a price and a time none of which are in
// any fixture's facts, writes the opt-out line itself, asks a question, and rambles past
// the budget. The real judge must refuse it for every fixture - no API call, no cache read.
const BROKEN_LINE = [
  "Great news! I found Sunnyside Splash Pad for you on Friday, and it's only $14 per child, starting at 9:15 sharp.",
  'You should also know about the Beaches Rec Centre program which opens on September 3 at 8:00 for everyone in Etobicoke.',
  'Want me to book it?',
  NUDGE_OPT_OUT,
].join(' ');

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1];
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { judgeSpokenLine, spokenFactSlots, spokenLineContext } = await tsImport(
    JUDGE_SRC,
    import.meta.url,
  );
  const { nudgeLineInput } = await tsImport(INPUT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'nudge', cachedOnly, getClient, cost);

  console.log(
    `nudge-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  const fixtures = only ? NUDGE_FIXTURES.filter((fixture) => fixture.id === only) : NUDGE_FIXTURES;
  if (fixtures.length !== (only ? 1 : NUDGE_FIXTURES.length)) {
    throw new Error(`fixture did not match --only=${only}`);
  }
  console.log(`corpus: ${fixtures.length} lines\n`);

  const results = [];
  for (const fixture of fixtures) {
    const input = nudgeLineInput(fixture.facts, fixture.language, fixture.address);
    const userMessage = JSON.stringify(spokenLineContext(input));
    const raw = broken
      ? BROKEN_LINE
      : (
          await cachedToolCall({
            tag: `nudge:${fixture.id}`,
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
    const sentences = countSentences(body);
    if (sentences > MAX_SENTENCES) failures.push(`sentences:${sentences}`);
    const hits = forbiddenHits(body, fixture, spokenFactSlots(input));
    if (hits.length > 0) failures.push(`forbidden:${hits.join(',')}`);

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
    console.log(`${tag}  ${r.fixture.id.padEnd(40)} "${r.body.slice(0, 100)}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const refused = results.filter((r) => r.failures.some((f) => f.startsWith('refused:')));
  const fabricated = results.filter((r) => r.failures.some((f) => f.startsWith('forbidden:')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));

  console.log('\n--- corpus metrics ---');
  console.log(
    `REFUSED LINES:           ${refused.length}  (0 required - there is no fallback sentence, so the family hears nothing)`,
  );
  console.log(`forbidden-word lines:    ${fabricated.length}  (0 required)`);
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0);

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
  console.error('nudge eval harness error:', err);
  process.exit(2);
});
