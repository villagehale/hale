// The introduction ask · composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/intro-voice.md) run through the
// REAL forced-tool-JSON request shape apps/web/lib/village/intros/voice.ts builds —
// REPLICATED here rather than imported, for the reason the follow-up, identity, lane and
// intake evals replicate: that module sits behind the web app's `~/` alias, which the tsx
// loader here cannot resolve. `introAskUserMessage` and `introAskRefusals` are the two
// replicas, and both are pinned against the real thing by voice.test.ts. The SKILL body
// and the model routing ARE imported live from packages/agent, so a skill edit or a
// model.ts re-tiering re-keys the cache and shows up here as a miss rather than as
// silence. `smsEncoding`/`smsSegments` and `OPT_OUT_LINE` are imported REAL — those are
// pure alias-free modules, and the GSM-7 table and the compliance line's exact length are
// precisely what a replica gets subtly wrong.
//
// WHY THIS EVAL EXISTS. Both intro asks used to be fixed strings, and both ended by
// telling the parent which token to type back ("Reply YES INTROS or NO INTROS.", then
// hours later "Reply YES INTRO or NO INTRO."). The founder read them live on 2026-08-13:
// marketing-blast grammar, not a chief of staff. So this suite measures two different
// things at once — whether the composed ask is good, and whether it has quietly become
// the copy it replaced. RETIRED_COPY is the second half, and it is deterministic.
//
// AND IT HAS ALREADY EARNED ITS KEEP ONCE. The first live recording of this suite passed
// every gate it had and still shipped six asks that said "Hale can make an introduction"
// and two that said "let us know" — one product speaking about itself in the third person
// while every acknowledgement in copy.ts says "I'll introduce you both". Nothing was
// watching for it, including the judge, which scored all six a 5. `third_person_self` and
// `first_person_plural` are now mechanical refusals in voice.ts, the skill says so
// outright, and the judge's rubric names both plus plain grammatical errors — the other
// thing it waved through ("Worth a intro?", scored 5). A rubric that passes a typo is not
// reading the copy.
//
// WHY THE BAR IS HIGH. There is no preset under this stage (founder doctrine 2026-08-12).
// A refused body is composed again with the refusal handed back, and when three attempts
// run out the sweep DEFERS: the family hears nothing this tick. "Unsendable" here is not
// a degraded message, it is a missing one.
//
// What is NOT tested here: the recompose/defer machinery and the sweep's reaction to it
// (voice.test.ts, run.test.ts — deterministic), and the end-to-end double opt-in
// (identity-journey.test.ts, real Postgres). This eval is only about the words.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-intro-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-intro-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-intro-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · unsendable asks — anything introAskRefusals() would refuse. Each one is an
//     introduction that does not happen.
//   · retired copy — an ask that is, or nearly is, one of the two deleted strings. The
//     keyword tail is caught mechanically; this catches the announcement in front of it.
//   · invented proper nouns — on the fixtures where the composer was handed no name at
//     all ("your kid's", "your daughter's", and every optin), a capitalised word it was
//     not given is a name it made up about a child (rule #1).
//   · a one-template corpus — every ask opening the same way, or wearing one of the
//     skill's own sentences. There is only one optin REQUEST in the product, so both kinds
//     share one gate; the fixtures header records why, and what three draws of that one
//     request actually measured.
// Everything else is the judge's bar (JUDGE_MIN per fixture).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  INTRO_VOICE_FIXTURES,
  MAX_RETIRED_SIMILARITY,
  RETIRED_COPY,
} from './intro-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import {
  normalizeForCompare,
  similarity,
  skillSampleSentences,
  variationGate,
  variationLines,
} from './lib/variation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'intro-voice.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');
const OPT_OUT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'opt-out.ts');

/** Mirrors MAX_TOKENS in voice.ts. */
const MAX_TOKENS = 256;

/** Three ways of opening across the five shipped asks. Higher than the two the follow-up
 * and identity suites ask for, because the thing this arc deleted was a house opening line
 * and the skill names that failure explicitly: "There is no house opening line, and if you
 * find yourself reaching for one, that is the line to avoid." */
const MIN_DISTINCT_OPENERS = 3;

// ── the composer's request shape, replicated from voice.ts ───────────────────

/** Mirrors `askJsonSchema`. */
const ASK_TOOL_SCHEMA = {
  type: 'object',
  properties: { ask: { type: 'string' } },
  required: ['ask'],
};

/** Mirrors `introAskUserMessage` — the kind, the three proposal facts, and any refused
 * attempts. There is no parameter on this shape that could carry the other household's
 * name, age, area or address, which is the structural half of the privacy rule. */
function introAskUserMessage(request, rejected = []) {
  const base =
    request.kind === 'optin'
      ? { kind: 'optin' }
      : {
          kind: 'proposal',
          counterpartWord: request.counterpartWord,
          ownChildPossessive: request.ownChildPossessive,
          anchorTitle: request.anchorTitle,
          anchorDay: request.anchorDay,
        };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

// ── the composer's introAskRefusals(), replicated from voice.ts ──────────────

/** Mirrors MAX_INTRO_SEGMENTS. */
const MAX_INTRO_SEGMENTS = 2;

const LINK_SHAPE = /https?:\/\/|www\./i;

/** Mirrors KEYWORD_INSTRUCTION. The instruction, never the word: "yes" and "no" are
 * ordinary English and a composed ask may well contain them. STOP is deliberately absent —
 * the CASL line is appended by the gate, not written by this composer. */
const KEYWORD_INSTRUCTION =
  /\b(reply|respond|text|send|type)\b[^.?!]{0,20}\b(yes|no|y\b|n\b|intro|intros)\b/i;

/**
 * Mirrors THIRD_PERSON_SELF — Hale as the SUBJECT OF A VERB, never the brand name.
 *
 * This suite is where the defect came from: the first live recording wrote "Hale can make
 * an introduction" in six asks out of six, and every one of them scored a 5 from a judge
 * that had not been told to care. "Another Hale family nearby" stays legal, because it is
 * the premise of the message and there is no other way to say it.
 */
const THIRD_PERSON_SELF =
  /\bHale\s+(can|could|will|would|is|isn't|has|have|makes|make|made|might|may|does|knows|thinks|found|sends|texts|introduces)\b/i;

/** Mirrors FIRST_PERSON_PLURAL. Same recording, same cause: "Let us know if you would
 * rather we never raise this" is a support queue, not a chief of staff. */
const FIRST_PERSON_PLURAL = /\b(we|we're|we'll|we've|us|our|ours)\b/i;

/** Bound in main() once the real modules load — the gates must reach the same GSM-7 table
 * the carrier bills on, and the same compliance line the send appends, not copies. */
let smsEncodingRef = () => 'gsm7';
let smsSegmentsRef = () => 1;
let maxIntroAskChars = 0;

function containsPossessive(lowerBody, possessive) {
  const noun = possessive
    .toLowerCase()
    .replace(/['’]s$/, '')
    .trim();
  return noun.length > 0 && lowerBody.includes(noun);
}

function stripAll(body, fragment) {
  if (fragment === '') return body;
  return body.split(fragment).join(' ').split(fragment.toLowerCase()).join(' ');
}

function introAskRefusals(body, request) {
  const found = [];
  if (body === '') return ['empty'];
  if (body.length > maxIntroAskChars) found.push('over_char_cap');
  if (smsSegmentsRef(body) > MAX_INTRO_SEGMENTS) found.push('over_segment_cap');
  if (smsEncodingRef(body) !== 'gsm7') found.push('not_gsm7');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if ((body.match(/\?/g) ?? []).length > 1) found.push('too_many_questions');
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');
  if (KEYWORD_INSTRUCTION.test(body)) found.push('instructs_keyword');
  if (THIRD_PERSON_SELF.test(body)) found.push('third_person_self');
  if (FIRST_PERSON_PLURAL.test(body)) found.push('first_person_plural');

  const lower = body.toLowerCase();
  if (!lower.includes('introduc') && !lower.includes('intro')) {
    found.push('introduction_word_missing');
  }

  let residue = body;
  if (request.kind === 'proposal') {
    if (!lower.includes(request.counterpartWord.toLowerCase())) {
      found.push('counterpart_word_missing');
    }
    if (!containsPossessive(lower, request.ownChildPossessive)) found.push('own_child_missing');
    if (request.anchorTitle !== null) {
      if (!lower.includes(request.anchorTitle.toLowerCase())) found.push('anchor_missing');
      residue = stripAll(residue, request.anchorTitle);
    }
    residue = stripAll(residue, request.ownChildPossessive);
  }

  if (body.includes('@')) found.push('carries_address');
  if (/\d/.test(residue)) found.push('invented_number');
  return found;
}

const GATE_NAMES = [
  'empty',
  'over_char_cap',
  'over_segment_cap',
  'not_gsm7',
  'carries_link',
  'too_many_questions',
  'not_a_sentence',
  'instructs_keyword',
  'third_person_self',
  'first_person_plural',
  'introduction_word_missing',
  'counterpart_word_missing',
  'own_child_missing',
  'anchor_missing',
  'carries_address',
  'invented_number',
];

// ── the retired copy, and the invented-name check ────────────────────────────

/** Has this ask come back as one of the two deleted strings? Substring first (the exact
 * sentence, punctuation and case ignored), then trigram Dice for the near-miss. */
function retiredCopyHits(body) {
  const hits = [];
  const normalizedBody = normalizeForCompare(body);
  for (const retired of RETIRED_COPY) {
    const normalizedRetired = normalizeForCompare(retired);
    if (normalizedBody.includes(normalizedRetired)) {
      hits.push(`retired_copy: reproduces "${retired.slice(0, 48)}..." verbatim`);
      continue;
    }
    const score = similarity(body, retired);
    if (score > MAX_RETIRED_SIMILARITY) {
      hits.push(`retired_copy: ${score.toFixed(2)} similar to "${retired.slice(0, 48)}..."`);
    }
  }
  return hits;
}

/**
 * Capitalised words the composer was never handed — a name it invented.
 *
 * Sentence-initial words are dropped (every sentence starts capitalised), and the words of
 * every fact in the request are allowed, so a session title or a weekday passes through.
 * "Hale" is allowed because Hale is who is writing. Anything left is a proper noun with no
 * source, which on the fixtures this runs against means a child's name.
 */
function inventedProperNames(body, request) {
  const allowed = new Set(['hale', 'i']);
  const facts =
    request.kind === 'proposal'
      ? [
          request.counterpartWord,
          request.ownChildPossessive,
          request.anchorTitle,
          request.anchorDay,
        ]
      : [];
  for (const fact of facts) {
    for (const word of String(fact ?? '').split(/[^\p{L}\p{N}]+/u)) {
      if (word !== '') allowed.add(word.toLowerCase());
    }
  }

  const found = [];
  for (const sentence of body.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/);
    for (const raw of words.slice(1)) {
      // Broken into the SAME pieces the allowed set was built from, and for the same two
      // reasons this suite's first live run found the hard way: "Drop-In" is two allowed
      // words rather than one unknown one ("DropIn"), and the head before an apostrophe is
      // what carries the name — "I'll" is a pronoun, "Maya's" is the name it may not have
      // invented. Normalizing one side differently from the other reads every hyphenated
      // session title Hale was HANDED as a proper noun it made up.
      for (const piece of raw.split(/[^\p{L}\p{N}'’]+/u)) {
        const word = piece.split(/['’]/)[0];
        if (word === '' || !/^\p{Lu}/u.test(word)) continue;
        if (allowed.has(word.toLowerCase())) continue;
        found.push(`invented_proper_name: ${JSON.stringify(word)} was never handed to it`);
      }
    }
  }
  return found;
}

/** Mirrors `plainText` in apps/web/lib/channel/coach/reply.ts (behind `~/`, so replicated —
 * the same replica the follow-up and identity-ask suites carry). */
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
  'You are a strict reviewer scoring ONE text message Hale sends a parent about introducing',
  'them to another family nearby. Score 1-5.',
  'There are two kinds. kind "optin" is the first and only time Hale raises introductions',
  'unprompted, and it was composed from NOTHING - no name, no neighbourhood, no child, no',
  'count of families. kind "proposal" means a specific match exists, and Hale was handed',
  'exactly three facts: a band word for the other family\'s child ("toddler",',
  '"preschooler"), the recipient\'s OWN child already written the way this parent asked for',
  '("Maya\'s", "your kid\'s"), and sometimes one real activity title and the weekday it',
  'falls on. It was handed nothing else and it has no tools.',
  'You are given the request it was answering, the message, and watchFor - fixture-specific',
  'notes on what right and wrong look like here.',
  'A 5 sounds like a competent human chief of staff raising something small: it gives a',
  'REASON rather than a claim, it does not oversell, it does not read as a mass text, and it',
  'is fine with being told no. The offer is small and it is treated as small. It is written',
  'in the first person singular, and it is written in correct English.',
  'TWO THINGS THAT ARE LOW, and are spelled out because an earlier version of this rubric',
  'scored both of them 5.',
  'FIRST, THE SPEAKER. Score the DEFECT, never the cure. The defect is exactly two things:',
  'the literal word "Hale" standing as the GRAMMATICAL SUBJECT of a verb ("Hale can make an',
  'introduction", "Hale will introduce you", "Hale found a match"), or the words "we", "us"',
  'or "our" ("let us know", "want us to reach out"). Nothing else counts.',
  'If the message refers to itself in the first person singular at all, this item is',
  'SATISFIED and you move on. You may NOT prefer one first-person construction over another.',
  '"I can introduce you", "I can make an introduction", "I\'ll reach out to them", "happy to',
  'introduce you" and "want me to introduce you?" are all equally correct, and marking one',
  'down for not being another is legislating phrasing, which is not your job here.',
  '"Another Hale family", "another Hale family nearby" and the like are CORRECT AND',
  'EXPECTED: a noun phrase naming the OTHER household, which is the one place that word',
  'belongs. That is not the product talking about itself, and a message opening with it has',
  'not failed this item. Do not infer a company voice from a formal-sounding verb, and do',
  'not mark down contractions ("there\'s", "I don\'t", "you\'re"): those are the house voice.',
  'SECOND: any plain grammatical error, however small - a wrong article ("Worth a intro?"),',
  'a disagreeing verb, a missing word, a mangled clause. This message is the whole of what',
  'the parent reads and a typo in it is the product looking broken. Read the sentence as a',
  'copy editor before you score it.',
  'A LOW score is also any of: announcement voice - a product telling a user about a feature;',
  'opening with "Something new", "Good news", "Introducing" or anything of that family;',
  'exclamation marks; a greeting ("Hi there") or a sign-off; telling the parent what to type',
  'back ("Reply YES", "text NO to decline", "just say yes or no") - which means naming a',
  'specific word or token to send, NOT merely asking a question a parent could answer yes or',
  'no to, which is the correct way to ask; overselling -',
  '"a great match", "perfect fit", "you\'ll love them" - which is the product\'s claim about',
  'itself rather than a reason; implying Hale knows more about the other family than it does',
  '- their name, their street, how far away they are, how many there are, what they are',
  "like, or that Hale has spoken to them; implying Hale remembers this family's history or",
  'calendar; hype, emoji, pressure, urgency or a deadline; more than one question; padding',
  'after the ask; anything longer than a glance.',
  'For "optin" specifically: a parent\'s first reaction to an offer of an introduction is',
  '"what did you tell them". A 5 answers that before they ask it - nothing is shared unless both',
  'families say yes - and says it can be switched off. Leaving both out is LOW.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in, one string for every fixture: it instructs a keyword
// ("Reply YES INTROS"), calls Hale by name ("Hale has"), uses the royal we ("us"), asks two
// questions, invents a number ("3"), drops every pinned proposal fact (no band word, no own
// child, no anchor), and opens in the exact announcement voice this arc deleted. So
// `--broken` proves instructs_keyword + third_person_self + first_person_plural +
// too_many_questions + invented_number + counterpart_word_missing + own_child_missing +
// anchor_missing + the retired-copy gate + the invented-name gate all bite, rather than
// one of them carrying the calibration alone.
//
// It carries a curly apostrophe AND an emoji, which are two different demonstrations. The
// curly apostrophe is the one this suite's first calibration run got wrong: `plainText`
// runs BEFORE the refusals in production, and it substitutes curly quotes to straight
// ones, so a curly apostrophe alone can never reach `not_gsm7` — it is laundered, exactly
// as prod launders it. The emoji is what a real non-GSM-7 body looks like after that
// laundering, and it is what actually trips the encoding gate.
const BROKEN_ASK =
  'Something new: Hale has 3 great matches near you 🙂. Want us to make an intro? Or would ' +
  'you rather not? Reply YES INTROS or NO INTROS.';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsEncoding, smsSegments } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  const { OPT_OUT_LINE } = await tsImport(OPT_OUT_SRC, import.meta.url);
  smsEncodingRef = smsEncoding;
  smsSegmentsRef = smsSegments;
  // Mirrors MAX_INTRO_ASK_CHARS — derived exactly as voice.ts derives it, off the real
  // compliance line, so a reworded opt-out moves this cap without anybody editing it.
  maxIntroAskChars = 306 - (OPT_OUT_LINE.length + 2);

  const skill = await agent.loadSkill(SKILL_PATH);
  const samples = await skillSampleSentences(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'intro-voice', cachedOnly, getClient, cost);

  console.log(
    `intro-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(
    `corpus: ${INTRO_VOICE_FIXTURES.length} asks | budget ${maxIntroAskChars} chars / ${MAX_INTRO_SEGMENTS} segments\n`,
  );

  const results = [];
  for (const fixture of INTRO_VOICE_FIXTURES) {
    const userMessage = introAskUserMessage(fixture.request, fixture.rejected ?? []);
    const raw = broken
      ? BROKEN_ASK
      : (
          await cachedToolCall({
            tag: `intro-voice:${fixture.id}`,
            model,
            system: skill.instructions,
            userMessage,
            toolName: 'ask',
            toolSchema: ASK_TOOL_SCHEMA,
            toolDescription: 'Return the one text asking this family about an introduction.',
            maxTokens: MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.ask;

    const body = flatten(raw);

    // The deterministic gates run FIRST and decide whether the judge runs at all. A body
    // the composer would refuse is never sent, so scoring its prose measures nothing and
    // pays a model to do it.
    const failures = introAskRefusals(body, fixture.request);
    failures.push(...retiredCopyHits(body));
    if (fixture.noProperNames) failures.push(...inventedProperNames(body, fixture.request));

    const usable = failures.length === 0;
    const verdict = usable
      ? await judge(fixture.id, {
          request: userMessage,
          message: body,
          watchFor: fixture.watchFor,
        })
      : null;
    if (verdict && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({ fixture, body, usable, failures });
  }

  // ── variation ──────────────────────────────────────────────────────────────
  // ONE gate over both kinds, not one per kind, because there is only ever one optin
  // REQUEST in the product — `{"kind":"optin"}` and nothing else — so an optin corpus has
  // exactly one member and nothing to be a near-duplicate of. Splitting the gate would
  // leave that half measuring nothing while telling a reader it had been checked. The
  // fixtures header records what three draws of that one request actually measured, and
  // why a once-ever surface is not gated on it.
  //
  // Only asks that would actually SHIP are measured: an unsendable body is not copy
  // anybody reads, and a refused sentence dragged into the corpus would move the opener
  // count on the strength of text that never left the building. The recompose fixture is
  // excluded too (`countsTowardVariance: false`) — it was handed a sentence to react to,
  // so its opening is the fixture's, not the model's.
  const shipped = results.filter((r) => r.usable && r.fixture.countsTowardVariance !== false);
  const variation = variationGate({
    items: shipped.map((r) => ({ id: r.fixture.id, text: r.body })),
    samples,
    minDistinctOpeners: MIN_DISTINCT_OPENERS,
  });
  for (const result of shipped) {
    result.failures.push(...(variation.failuresById[result.fixture.id] ?? []));
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- asks ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${tag}  ${r.fixture.id.padEnd(30)} [${String(r.body.length).padStart(3)}/${maxIntroAskChars}] "${r.body}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const unsendable = results.filter((r) => r.failures.some((f) => GATE_NAMES.includes(f)));
  const retired = results.filter((r) => r.failures.some((f) => f.startsWith('retired_copy:')));
  const inventedNames = results.filter((r) =>
    r.failures.some((f) => f.startsWith('invented_proper_name:')),
  );
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));

  console.log('\n--- corpus metrics ---');
  console.log(
    `UNSENDABLE ASKS:         ${unsendable.length}  (0 required - there is no preset underneath, so the introduction just does not happen)`,
  );
  console.log(
    `retired copy:            ${retired.length}  (0 required - the two strings this arc deleted, and near-misses of them)`,
  );
  console.log(
    `invented proper names:   ${inventedNames.length}  (0 required - rule #1; it was handed no name at all)`,
  );
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);
  for (const line of variationLines(variation)) console.log(line);

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass = results.every((r) => r.failures.length === 0) && variation.passed;

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
  console.error('intro-voice eval harness error:', err);
  process.exit(2);
});
