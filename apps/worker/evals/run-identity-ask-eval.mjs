// The identity ask · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/identity-ask.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/channel/identity/ask-voice.ts builds —
// REPLICATED here rather than imported, for the reason the follow-up, lane and intake
// evals replicate: that module sits behind the web app's `~/` alias, which the tsx loader
// here cannot resolve. The SKILL body and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows up
// here as a miss rather than as silence. `smsEncoding` IS imported real — sms-segments.ts
// is a pure module with no aliases, and the GSM-7 table is exactly the thing a replica
// would get subtly wrong.
//
// WHY THE BAR IS HIGH. There is no preset line under this stage (founder doctrine
// 2026-08-12). A body that fails the gates is composed again with the failure fed back,
// and if three attempts run out nothing goes at all: at intake the parent is never asked
// their name, and in the intros sweep a pair that two families both said yes to sits until
// its window closes. So "unsendable" here is not a degraded message, it is a missing one.
//
// What is NOT tested here: the recompose/defer machinery and both callers' reactions to it
// (ask-voice.test.ts, machine.test.ts, intros/run.test.ts — all deterministic), and the
// end-to-end loop (intros/identity-journey.test.ts, real Postgres). This eval is only
// about the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-identity-ask-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-identity-ask-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-identity-ask-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · unsendable asks — anything the composer's own identityAskRefusals() would refuse.
//     Every one is a question the parent never gets asked.
//   · forbidden-pattern hits — a word about the OTHER household, or about a child. The
//     composer is handed a reason and a gap list and nothing else, so either is invented,
//     and inventing a fact about a family that agreed to an introduction and nothing more
//     is the disclosure this whole feature exists to avoid (rule #1).
//   · one-template corpus — every introduction ask opening the same way. A parent may get
//     the start-of-life one and an intros one months apart, and the variation the model is
//     here to provide has to be visible across the corpus rather than merely absent from
//     any single line.
// Everything else is the judge's bar (JUDGE_MIN per fixture).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { IDENTITY_ASK_FIXTURES } from './identity-ask-fixtures.mjs';
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
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'identity-ask.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');

/** How many distinct openings the introduction asks must show between them. Two is a low
 * bar on purpose — it catches a corpus that has collapsed onto one template without
 * pretending to measure style. */
const MIN_DISTINCT_OPENERS = 2;

/** Shortest string that can be an ARGUMENT rather than a label. A real verdict here runs
 * to a paragraph; the collision this guards against produced reasons of twelve and fifteen
 * characters, so anything under this is a score written blind, not a low bar on prose. */
const MIN_JUDGE_REASON_CHARS = 40;

function normalizeForCompare(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first three words, as the cheap stand-in for "how this message opens". */
function opener(body) {
  return normalizeForCompare(body).split(' ').slice(0, 3).join(' ');
}

// ── the composer's request shape, replicated from ask-voice.ts ───────────────

/** Mirrors `askJsonSchema`. */
const ASK_TOOL_SCHEMA = {
  type: 'object',
  properties: { ask: { type: 'string' } },
  required: ['ask'],
};

/** Mirrors `identityAskUserMessage` — the reason, the gaps, and any refused attempts.
 * Nothing about the family or the counterpart can ride in on this shape. */
function identityAskUserMessage(request, rejected = []) {
  const base = { reason: request.reason, missing: [...request.missing] };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

const MAX_TOKENS = 128;

// ── the composer's gates, replicated from ask-voice.ts ───────────────────────

const MAX_ASK_CHARS = 160;

/**
 * The consent acknowledgment the `getting_started` ask is appended to, and the tail budget
 * it leaves. Replicated from apps/web/lib/channel/intake/copy.ts for the alias reason
 * above — and asserted against the real constant by ask-voice.test.ts, which pins
 * `ASSENT_ACK.length + 1 + MAX_TAIL_ASK_CHARS === MAX_ASK_CHARS`. If the ack is ever
 * reworded, that test fails first and this line has to follow.
 */
const ASSENT_ACK =
  "Done - you're covered. I only text when something actually matters, and STOP always works.";
const MAX_TAIL_ASK_CHARS = MAX_ASK_CHARS - ASSENT_ACK.length - 1;

const LINK_SHAPE = /https?:\/\/|www\./i;

function askCharCap(request) {
  return request.reason === 'getting_started' ? MAX_TAIL_ASK_CHARS : MAX_ASK_CHARS;
}

function identityAskRefusals(body, request) {
  const found = [];
  if (body === '') return ['empty'];
  if (body.length > askCharCap(request)) found.push('over_char_cap');
  if (smsEncodingRef(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if ((body.match(/\?/g) ?? []).length > 1) found.push('too_many_questions');
  // Mirrors the `not_a_sentence` gate: the ask is appended after a full stop, so a clause
  // that continues the previous sentence reads as a typo. Caught on this eval's own first
  // live run, which is why it exists.
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');

  const lower = body.toLowerCase();
  if (request.missing.includes('name') && !lower.includes('name')) found.push('name_word_missing');
  if (request.missing.includes('email') && !lower.includes('email')) {
    found.push('email_word_missing');
  }
  if (request.reason === 'introduction' && !lower.includes('introduc')) {
    found.push('introduction_word_missing');
  }
  if (body.includes('@')) found.push('carries_address');
  if (/\d/.test(body)) found.push('invented_number');
  return found;
}

/** Bound in main() once the real module is loaded — the gates have to reach the same
 * GSM-7 table the segment counter bills on, not a copy of it. */
let smsEncodingRef = () => 'gsm7';

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

// ── the judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text message Hale sends a parent asking for a',
  'plain fact about the parent themselves - what to call them, an email address, or both.',
  'Hale composed this nearly blind: it was shown only WHICH facts are missing and WHY it',
  'needs them. No family, no children, no other household, no tools.',
  'You are given the moment it was written for, what was missing, the message, and watchFor',
  '- fixture-specific notes on what right and wrong look like here. Score 1-5.',
  'The score tool takes your ARGUMENT first and the number second, and that order is the',
  'point: write what is right and wrong with THIS message in your own words - a few',
  'sentences quoting what it actually says - and only then score it. A one-word argument,',
  'or an argument that merely names the moment, is not an argument.',
  'There are two moments and they are scored differently.',
  'MOMENT "getting_started": this message is the TAIL of a confirmation Hale has already',
  'written ("Done - you\'re covered. I only text when something actually matters, and STOP',
  'always works."). That sentence says the parent is covered and never says what covered',
  'MEANS, and this tail is the only place it is ever said. So it has TWO jobs inside about',
  'seventy characters: one clause saying what Hale does from here - it keeps watching this',
  "family's dates on its own AND the parent can text it a parenting question whenever they",
  'have one - and the ask itself.',
  'A 5 does both in one plain sentence, tight enough to fit.',
  'A message that names only ONE of the two halves (it watches but is never spoken to, or',
  'it answers but never watches) is a 3.',
  'A message that only asks for the name is a 2 however well it reads: the parent is left',
  'with a number that collects details and no idea what it does.',
  'Do not mark it down for terseness - there is no room, and a clipped sentence that says',
  'both things beats an elegant one that says neither.',
  'Re-thanking, re-confirming the coverage, mentioning STOP, greeting, or explaining why',
  'Hale wants a name are all LOW - the sentence in front already did that work.',
  'MOMENT "introduction": days ago this parent said yes to being introduced to another Hale',
  'family, and Hale cannot make the introduction without what is missing. A 5 ties the ask',
  "to that introduction in the parent's own terms and asks plainly. This parent has been a",
  'Hale family for months, so a line about what Hale watches or what it can answer belongs',
  'to the start of life and is LOW here - it reads as a company re-introducing itself',
  'instead of asking the small thing it needs. A LOW score is any of:',
  'reading like a company collecting contact details; naming, counting, locating or',
  'describing the other household in ANY way, including "a family near you" or "they have a',
  'toddler"; implying Hale has been talking to them; pressure, urgency or a deadline.',
  'LOW at either moment: more than one question; hype, exclamation marks or emoji; a',
  'greeting or a sign-off; an example address; any invented specific - a number, a date, a',
  'place, a link, or anything about a child; pointing at an app; padding after the ask; more',
  'than about two short sentences.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: hype, two questions, an invented number, an emoji, a
// link, an example address, and a description of the other household — trips not_gsm7 +
// carries_link + too_many_questions + carries_address + invented_number +
// introduction_word_missing + the forbidden patterns + the judge, so `--broken` proves
// every layer bites.
const BROKEN_ASK =
  'Hi there! 😊 A family near you with a toddler is waiting - what is your name? Can you send ' +
  'your email like sam@example.com within 2 days? See www.example.com';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsEncoding } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  smsEncodingRef = smsEncoding;
  const skill = await agent.loadSkill(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'identity-ask', cachedOnly, getClient, cost);

  console.log(
    `identity-ask eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(
    `corpus: ${IDENTITY_ASK_FIXTURES.length} asks | tail budget ${MAX_TAIL_ASK_CHARS} chars, standalone ${MAX_ASK_CHARS}\n`,
  );

  const results = [];
  for (const fixture of IDENTITY_ASK_FIXTURES) {
    const userMessage = identityAskUserMessage(fixture.request, fixture.rejected ?? []);
    const raw = broken
      ? BROKEN_ASK
      : (
          await cachedToolCall({
            tag: `identity-ask:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage,
            toolName: 'ask',
            toolSchema: ASK_TOOL_SCHEMA,
            toolDescription: "Return the one text asking for the parent's own detail.",
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.ask;

    const body = flatten(raw);
    const failures = identityAskRefusals(body, fixture.request);
    for (const pattern of fixture.forbiddenPatterns ?? []) {
      if (pattern.test(body)) failures.push(`forbidden:${pattern.source.slice(0, 40)}`);
    }

    // NOTHING in this payload may be called `reason`. It used to be: the judge was handed
    // the composer's own user message, which carries `reason: "getting_started"`, and the
    // verdict schema's FIRST property is also called `reason` — so the judge filled its
    // argument slot with the string it had just read. Nine of twelve recorded verdicts came
    // back as `{"reason":"getting_started","score":5}`: a number with nothing conditioning
    // it, which is the score-blind failure lib/harness.mjs documents, wearing a key
    // collision instead of a schema order. The radar judge, whose payload has no such key,
    // writes real arguments — that is the control. Renaming is the fix; the guard below is
    // what keeps it fixed.
    const verdict = await judge(fixture.id, {
      moment: fixture.request.reason,
      missing: [...fixture.request.missing],
      refusedBefore: fixture.rejected ?? [],
      message: body,
      watchFor: fixture.watchFor,
    });
    if ((verdict.reason ?? '').trim().length < MIN_JUDGE_REASON_CHARS) {
      failures.push(`judge-unargued:${verdict.score} ("${verdict.reason ?? ''}")`);
    } else if (verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({ fixture, body, failures });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- asks ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    const cap = askCharCap(r.fixture.request);
    console.log(
      `${tag}  ${r.fixture.id.padEnd(24)} [${String(r.body.length).padStart(3)}/${cap}] "${r.body.slice(0, 80)}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const GATE_NAMES = [
    'empty',
    'over_char_cap',
    'not_gsm7',
    'carries_link',
    'too_many_questions',
    'not_a_sentence',
    'name_word_missing',
    'email_word_missing',
    'introduction_word_missing',
    'carries_address',
    'invented_number',
  ];
  const unsendable = results.filter((r) => r.failures.some((f) => GATE_NAMES.includes(f)));
  const invented = results.filter((r) => r.failures.some((f) => f.startsWith('forbidden:')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));
  const unargued = results.filter((r) => r.failures.some((f) => f.startsWith('judge-unargued:')));
  const introOpeners = new Set(
    results.filter((r) => r.fixture.request.reason === 'introduction').map((r) => opener(r.body)),
  );

  console.log('\n--- corpus metrics ---');
  console.log(
    `UNSENDABLE ASKS:         ${unsendable.length}  (0 required - there is no fallback line, so the parent is never asked)`,
  );
  console.log(
    `invented counterpart:    ${invented.length}  (0 required - rule #1; it was handed no fact about them)`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  console.log(
    `verdicts with no argument: ${unargued.length}  (0 required - a score written blind is not a verdict)`,
  );
  console.log(
    `distinct intro opens:    ${introOpeners.size}  (>= ${MIN_DISTINCT_OPENERS} required - one template is a preset body)`,
  );

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    results.every((r) => r.failures.length === 0) && introOpeners.size >= MIN_DISTINCT_OPENERS;

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
  console.error('identity-ask eval harness error:', err);
  process.exit(2);
});
