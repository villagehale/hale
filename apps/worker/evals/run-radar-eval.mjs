// VIL-238 · M3 radar payload composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/radar-voice.md) run through the
// REAL request shape runAgent builds for a no-tools voice skill — REPLICATED here
// rather than imported, for the same reason the intake/sentinel/drafter evals
// replicate: the web modules sit behind the `~/` alias, which the tsx loader here
// cannot resolve. The SKILL body and the model routing ARE imported live from
// packages/agent, so a skill edit or a model.ts re-tiering re-keys the cache and shows
// up here immediately.
//
// What is NOT tested here: the DECIDE cascade. It is pure, deterministic code with its
// own vitest suite (apps/web/lib/channel/intake/radar-decide.test.ts) and no model runs
// in it — that is the point of the split. This eval is only about the one thing a model
// does in M3: turning a decision object into a text message without inventing anything.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-radar-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-radar-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-radar-eval.mjs --cached-only                    # CI: replay only
//
// Calibrated BOTH directions: the real cached model clears every gate; the --broken
// stand-in (a composer that invents a venue, a price and a time, re-asks the watch
// question, and rambles past the segment budget) fails the fabrication gate, the
// question gate, the length gate AND the tone judge — proving the gates have teeth.
//
// THE ATTRIBUTION GATE (2026-08-13). A correct find with nothing saying where it came
// from is trivia: the parent reads a date they could have googled and has no idea a
// service just ran for them. So a message that carries a find must also carry, in its
// lead sentence, that Hale already looked — scored by its OWN judge, kept apart from
// voice because the two come apart. That is measured, not assumed: run against the skill
// as it stood the day before, the corpus scored a mean of 4.61 for voice and 1.88 for
// attribution, with 14 of 17 finds landing as bare fact. Every one of those messages was
// already shipping.
//
// Its twin is in fabrications(): an attribution with a SPECIFIC in it (a postal code, a
// count of places swept, a time the sweep ran) is a new way to invent, and the same hard
// zero catches it.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import {
  JUDGE_MIN,
  JUDGE_SAMPLES_MEDIAN,
  cachedTextCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { RADAR_FIXTURES, WATCH_OFFER } from './radar-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const RADAR_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'radar-voice.md');

const MAX_TOKENS = 300;
/** Mirrors MAX_PAYLOAD_SEGMENTS in apps/web/lib/channel/intake/radar-voice.ts, raised to
 * three by the v2 WATCH_OFFER: the richest deterministic render plus the now-longer
 * appended offer is 324 septets, so two would make the grounded fallback unsendable. */
const MAX_PAYLOAD_SEGMENTS = 3;
/** The copy contract's hard ceiling: this is a text message, not a newsletter. */
const MAX_SENTENCES = 3;

// ── replicated: the composer's context shape (radar-voice.ts radarVoiceContext) ──
// The model sees the decision's FACTS and nothing else — no candidate uuid, no
// internal follow-up flag. This IS the fabrication haystack: anything the message
// says that is not in here was invented.

function townLabel(municipality) {
  return municipality
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Mirrors FIRST_FIND_BEAT in apps/web/lib/channel/intake/radar-voice.ts. The promise is
 * INJECTED rather than left to the model: "a day or two" is a specific, and a specific
 * the model writes from its own head is the fabrication this stage exists to stop. */
const FIRST_FIND_BEAT = 'Your first weekend find lands in a day or two.';

function radarVoiceContext(decision) {
  const pick = decision.weekendPick;
  const reg = decision.registrationLine;
  const emptyHanded = pick === null && reg === null && decision.checkpoint === null;
  return {
    firstFindBeat: emptyHanded ? FIRST_FIND_BEAT : null,
    weekendPick: pick
      ? {
          what: pick.candidateRef.title,
          where: pick.candidateRef.venueName,
          day: pick.day,
          kidNames: pick.kidNames,
          whyFacts: pick.whyFacts,
        }
      : null,
    registration: reg
      ? {
          town: townLabel(reg.windowRef.municipality),
          cycle: reg.windowRef.cycleLabel,
          opensAtLocal: reg.opensAtLocal,
          kidNames: reg.kidNames,
          residentNote: reg.residentNote,
          ageApproximate: reg.ageApproximate,
        }
      : null,
    // The silence with a reason in it: this town opened a cycle before and its next
    // dates are not posted. Carries the TOWN, which a null-registration context never
    // used to — so a between-cycles message that names it is grounded, not inventing.
    registrationAbsence: decision.registrationAbsence
      ? {
          town: townLabel(decision.registrationAbsence.cycleRef.municipality),
          lastCycle: decision.registrationAbsence.cycleRef.cycleLabel,
          lastOpenedAtLocal: decision.registrationAbsence.lastOpenedAtLocal,
          nextCycle: decision.registrationAbsence.nextCycleLabel,
          // The TENSE: the same cycle read as news rather than history. A boolean and
          // nothing else - the model already has the date, and the link the shell
          // appends under the message is the one fact it may never write.
          stillOpenPage: decision.registrationAbsence.stillOpen !== null,
        }
      : null,
    // The reviewed row's own words and the names it may carry — never the row id.
    checkpoint: decision.checkpoint
      ? { task: decision.checkpoint.task, kidNames: decision.checkpoint.kidNames }
      : null,
    offerQuestion: decision.offerQuestion,
  };
}

// ── replicated: sms-segments.ts ─────────────────────────────────────────────
// A body that is entirely GSM-7 carries 160 septets alone / 153 per concatenated
// part; one character outside GSM-7 flips the whole body to UCS-2 (70 / 67). The
// budget is what the copy contract is written against, so the gate has to count
// the same way the sender will.

const GSM7_BASIC = new Set(
  [
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ]
    .join('')
    .split(''),
);
const GSM7_EXTENDED = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

function smsSegments(text) {
  let gsm7 = true;
  for (const char of text) {
    if (!GSM7_BASIC.has(char) && !GSM7_EXTENDED.has(char)) {
      gsm7 = false;
      break;
    }
  }
  if (!gsm7) return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
  let septets = 0;
  for (const char of text) septets += GSM7_EXTENDED.has(char) ? 2 : 1;
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

// ── parse (replicates firstJsonObject + the strict voice schema) ─────────────

function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseRadarVoice(answer) {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'message') return null;
  if (typeof value.message !== 'string' || value.message.trim() === '') return null;
  return value.message;
}

// ── the hard fabrication gate ───────────────────────────────────────────────
// Every proper noun and every number in the message must trace back to the decision
// object. This is the whole point of M3's DECIDE/COMPOSE split: the model may choose
// the words, never the facts. A venue, a price, a date, or a time that appears
// nowhere in the context is a fabrication, and one of them in a family's FIRST
// message from Hale would be indistinguishable from a real find.

/** Capitalised words that are not proper nouns about this family's week. */
const ALLOWED_CAPS = new Set(['Hale', 'I', 'A', 'An', 'The', 'And', 'But', 'So', 'If', 'It']);

/**
 * Specifics about the LOOK rather than about the find — the fabrication the attribution
 * clause opened the door to. The composer is handed facts and no geography: the postal
 * code the parent texted never reaches this stage, and neither does a count of places
 * checked, a radius, a time the check ran, or a cadence it runs on. Saying Hale looked is
 * true of every one of these turns; saying WHAT it looked at is a detail invented to make
 * the looking sound impressive, and a parent cannot tell the two apart.
 *
 * Checked against the same haystack as every other fabrication, so a phrase that IS in
 * the facts (a title containing "weekly", say) is still allowed to be said.
 */
const INVENTED_SCOPE = [
  'postal',
  'postcode',
  'zip',
  'radius',
  'this morning',
  'overnight',
  'last night',
  'every day',
  'every week',
];

function fabrications(message, context) {
  const hay = JSON.stringify(context).toLowerCase();
  const offenders = [];

  const lowerMessage = message.toLowerCase();
  for (const phrase of INVENTED_SCOPE) {
    if (lowerMessage.includes(phrase) && !hay.includes(phrase)) {
      offenders.push(`scope "${phrase}" is in no fact — Hale looked, it did not say where`);
    }
  }

  for (const number of message.match(/\d+/g) ?? []) {
    if (!hay.includes(number)) offenders.push(`number "${number}" is in no fact`);
  }
  for (const url of message.match(/https?:\/\/\S+/g) ?? []) {
    offenders.push(`link "${url}" — this skill is never given one`);
  }
  // A capitalised word that does not open a sentence is a name: a venue, a town, a
  // child. Sentence-initial words are skipped (every sentence starts capitalised).
  for (const sentence of message.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/);
    for (const [index, word] of words.entries()) {
      if (index === 0) continue;
      const bare = word
        .replace(/^[^A-Za-z]+/, '')
        // The possessive of a grounded name is the same name ("Maya's" ← "Maya"); an
        // INVENTED possessive still fails, because the bare name is still in no fact.
        .replace(/['’]s$/i, '')
        .replace(/[^A-Za-z]+$/, '');
      if (!/^[A-Z][a-z]/.test(bare)) continue;
      if (ALLOWED_CAPS.has(bare)) continue;
      if (!hay.includes(bare.toLowerCase())) offenders.push(`name "${bare}" is in no fact`);
    }
  }
  return [...new Set(offenders)];
}

/** "6:30 a.m." is ONE injected fact, not two sentence endings. The ceiling counts
 * sentences a parent reads, so the abbreviation's own periods are neutralised before
 * the split — otherwise a message that puts the opening time mid-sentence is failed for
 * a punctuation mark it was handed. */
const CLOCK_ABBREVIATION = /\b([ap])\.m\./gi;

function countSentences(message) {
  return message
    .replace(CLOCK_ABBREVIATION, '$1m')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

/**
 * Whether this turn has something Hale LOOKED UP to attribute. When every rung is null
 * there is nothing Hale found, and the skill hands that turn a mapping line that already
 * says Hale is out looking — scoring it for attribution would fail the honest-absence
 * message for being honest, and would push a second "I checked" onto the one message
 * that must not pad.
 *
 * A between-cycles absence DOES count, and that is the point of typing it: "your town's
 * fall cycle opened on the 1st and winter is not posted" is a municipal calendar someone
 * went and read. Stone-cold it is a database row from a stranger's number; it earns its
 * attribution exactly like a find, and the emptyHanded exemption would hide that.
 */
function carriesAFind(decision) {
  return (
    decision.weekendPick !== null ||
    decision.registrationLine !== null ||
    decision.registrationAbsence !== null ||
    decision.checkpoint !== null
  );
}

/**
 * Mirrors renderActionLine + composeRadarMessage's append in
 * apps/web/lib/channel/intake/action-line.ts: ONE deterministic line, composed by the
 * shell UNDER the model's message, carrying at most one hand-verified URL.
 *
 * It is here because the budget the gate measures has to be the payload production
 * SENDS. Measuring `${message}\n\n${WATCH_OFFER}` alone passed strings the sender then
 * discards for being three-and-a-bit segments long, which is the defect this replica
 * closes rather than the one it adds.
 *
 * Only the still-open arm is replicated, because that is the only arm any fixture's
 * decision reaches: no fixture carries a `registerUrl` on the upcoming rung or a
 * `verifiedUrl` on a pick. The other four moves' budget is pinned deterministically
 * instead (radar-voice.test.ts iterates every seeded registration row), and what the
 * composed voice does on those turns is the deferred question, not this gate's.
 */
function tailFor(decision) {
  const stillOpen = decision.registrationAbsence?.stillOpen ?? null;
  if (stillOpen === null) return '';
  return `\n\nThe page is here: ${stillOpen.registerUrl}`;
}

/** The whole payload, exactly as the sender bills it. */
function payloadOf(decision, message) {
  return `${message}${tailFor(decision)}\n\n${WATCH_OFFER}`;
}

/**
 * WHERE A RECALLED FACT LANDS, or -1.
 *
 * A token is a string, or an ARRAY of the ways English writes one fact. "a visit at 18
 * months" and "an 18-month visit" are the same reviewed row said two ways, and a gate
 * that pins the inflection rather than the fact fails a message that delivered it — on a
 * draw, not on a change, which is the worst kind of red. Any one spelling counts; all of
 * them missing is the failure. It is never a way to accept a DIFFERENT fact: every
 * alternative has to be the same thing the fixture exists for.
 */
function indexOfFact(lower, token) {
  const spellings = Array.isArray(token) ? token : [token];
  const hits = spellings.map((t) => lower.indexOf(t.toLowerCase())).filter((at) => at !== -1);
  return hits.length === 0 ? -1 : Math.min(...hits);
}

function checkMessage(fixture, message, judgeScore, attributionScore) {
  const failures = [];
  if (!message) return ['answer failed to parse into a strict { message } object'];

  const context = radarVoiceContext(fixture.decision);
  failures.push(...fabrications(message, context));

  if (message.includes(WATCH_OFFER)) {
    failures.push('re-asks the watch question the shell appends — the parent is asked twice');
  }
  if (message.includes('?')) {
    failures.push('writes a question of its own (the shell owns the only question)');
  }

  const segments = smsSegments(payloadOf(fixture.decision, message));
  if (segments > MAX_PAYLOAD_SEGMENTS) {
    failures.push(`payload is ${segments} SMS segments > ${MAX_PAYLOAD_SEGMENTS}`);
  }

  const sentences = countSentences(message);
  if (sentences > MAX_SENTENCES) {
    failures.push(`${sentences} sentences > ${MAX_SENTENCES}`);
  }

  const lower = message.toLowerCase();
  for (const token of fixture.expect.mustRecall ?? []) {
    if (indexOfFact(lower, token) === -1) {
      failures.push(`never delivers the fact it exists for: ${JSON.stringify(token)}`);
    }
  }
  // The cascade, checked as ORDER rather than as an opinion: each token must be
  // present and must not appear before the one that outranks it.
  let cursor = -1;
  for (const token of fixture.expect.orderedRecall ?? []) {
    const at = indexOfFact(lower, token);
    if (at === -1) {
      failures.push(`never delivers the fact it exists for: ${JSON.stringify(token)}`);
      break;
    }
    if (at < cursor) {
      failures.push(`leads with the wrong block: ${JSON.stringify(token)} comes too early`);
      break;
    }
    cursor = at;
  }
  for (const token of fixture.expect.forbidden ?? []) {
    if (lower.includes(token.toLowerCase())) {
      failures.push(`says ${JSON.stringify(token)}, which no fact supports`);
    }
  }

  if (judgeScore !== null && !(judgeScore >= JUDGE_MIN)) {
    failures.push(`voice score ${judgeScore} < ${JUDGE_MIN}`);
  }
  if (attributionScore !== null && !(attributionScore >= JUDGE_MIN)) {
    failures.push(
      `attribution score ${attributionScore} < ${JUDGE_MIN} — the find lands as trivia, not as the watch reporting back`,
    );
  }
  return failures;
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring the FIRST useful text message Hale sends a parent,',
  'sixty seconds after they texted their kids\' names to a number on a poster. You are',
  'given the FACTS Hale decided on and the message written from them.',
  'Score VOICE & FAITHFULNESS on a 1-5 integer scale. A 5 sounds like a competent',
  'neighbour who already looked something up: quiet, plain-spoken, specific, short,',
  'leading with the useful thing. It states only the given facts, and when a fact is',
  'absent (no pick, no registration date) it says so plainly instead of padding.',
  'A field the facts do not carry - a null venue, no price, no age range - is simply',
  'absent. A message that names no venue because there is none IS complete, and you never',
  'mark it down for that, ask it for a placeholder, or suggest wording that would invent',
  'one: a stand-in like "location TBA" is a detail Hale was not given.',
  'A specific is INVENTED only when you cannot find it in the facts you were given. Read',
  'the facts object before you call anything invented: a town, a cycle name, a date, a',
  'time, an activity title, an age range or a name that appears there is GIVEN, however',
  'specific it looks, and naming it is the message doing its job.',
  '`registrationAbsence` is this town\'s LAST cycle - its name and the morning it opened.',
  'It is not a claim that anything is shut and it is not a request for the next cycle.',
  'When it carries `stillOpenPage: true` that cycle is the CURRENT one, still the one to',
  'act on: a message that says it opened on `lastOpenedAtLocal` and stops is exactly',
  'right, and you never mark it down for leaving out `nextCycle`, for not saying',
  'registration has closed, or for not warning that the parent has missed it. When',
  '`stillOpenPage` is false the season has gone and the next dates are not posted, and',
  'saying both halves plainly is what a 5 looks like.',
  'THE COMPOSER IS WRITING TO A CONTRACT (packages/agent/skills/radar-voice.md), and',
  'three things that contract REQUIRES are neither padding nor inventions. ONE: a few',
  'words inside the LEAD sentence saying Hale already went and looked - "I found", "I',
  'checked", "I looked up", "I had a look" - are mandatory and are scored by a separate',
  'reviewer. Never mark a message down for them and never read them as corporate voice.',
  'They add no fact of their own, so they are invented only when they carry a scope the',
  'facts do not: a count of places checked, an area swept, a postal code, a time the',
  'check ran. TWO: when `registration` and `registrationAbsence` are BOTH null, one short',
  'clause saying nothing has a registration date coming up is the instructed copy and not',
  'a speculation - and so is one short clause saying Hale is still learning the area and',
  'will have a pick soon when `weekendPick` is null. Neither is a claim about data the',
  'writer lacks; both are what the absence is supposed to sound like. THREE:',
  '`firstFindBeat`, where the facts carry it, is a sentence Hale HANDED the composer to',
  'reproduce verbatim. It is not padding and not a promise the writer made up.',
  'A LOW score is hype or exclamation marks, brand/corporate voice ("We are excited to"),',
  'listing facts like a database row, restating every field, sounding like an ad, burying',
  'the useful fact under the frame, or any detail not present in the facts. Reply with',
  'ONLY the score tool.',
].join(' ');

/**
 * The second judge, and it scores ONE property so a lovely message cannot carry a missing
 * one past it. Kept apart from voice deliberately: the pre-change corpus proves they come
 * apart — the same bodies that scored 4 and 5 for voice attributed nothing at all.
 */
const ATTRIBUTION_JUDGE_SYSTEM = [
  'You are scoring ONE property of the first useful text message Hale sends a parent, a',
  "minute after they texted their kids' names to a number on a poster: does the message",
  'present its find as the product of a look Hale ALREADY TOOK for this family? Nothing',
  'else. Not warmth, not length, not whether the facts are the right ones.',
  'Score 1-5.',
  'A 5 folds a few words into the FIRST sentence that make Hale the one who went and',
  'checked, so the fact arrives as a service reporting back on work already done. It is',
  'half a clause, not a preamble: the useful fact is still in that first sentence.',
  'The test is WHO DID THE LOOKING, in whatever words. A first-person verb of finding or',
  'checking inside the lead sentence - "I found", "I checked", "I looked up", "I had a',
  'look" - IS the attribution, and scores 5 when the fact lands in that same sentence. It',
  'does not have to say what was searched, how much was searched, or that it was searched',
  'for these particular children: requiring that would be requiring the invented specifics',
  'you are told to score 1 for below. Do not invent a further test.',
  'A 3 gestures at it late - after the fact has already landed flat, or in a sentence of',
  'its own that the fact then follows.',
  'A 1 states the fact with nothing at all saying where it came from. True, and',
  'indistinguishable from a piece of trivia a stranger sent.',
  'Score 1 ALSO for the opposite failure - a look with specifics in it THE FACTS DO NOT',
  'CARRY. The test is the facts object in front of you, not your sense of what Hale could',
  'plausibly know: a town, a cycle name, a date, a time, an activity title or a child\'s',
  'name that appears in those facts is GIVEN, and naming it inside the look is the message',
  'reporting back, never an invented scope. A postal code, an area swept, a count of',
  'places checked, a time the check ran or a schedule it runs on appears in no payload, so',
  'any of THOSE is invented, and an invented scope is worse than no attribution at all.',
  'Score 1 for a greeting, a brand line ("Welcome to Hale"), hype, or anything that reads',
  'as a product introducing itself. This is a person saying they already looked.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: invents a venue, a price and a time none of which are
// in any fixture's decision, re-asks the watch question, and rambles past the budget.
// Every gate must reject it — no API call, no cache read.
//
// It also attributes NOTHING, and that is deliberate as of the attribution gate: the
// first line used to open "I found Sunnyside Splash Pad for you", which is a perfectly
// good attribution wrapped around a fabricated venue, and the attribution judge duly gave
// the broken corpus a mean of 4.8. A stand-in that passes the one gate whose teeth are a
// model's opinion calibrates nothing, so the finding verb came out and the flat statement
// stayed.
const BROKEN_MESSAGE = [
  "Great news! Sunnyside Splash Pad is on Friday, and it's only $14 per child, starting at 9:15 sharp.",
  'You should also know about the Beaches Rec Centre program which opens on September 3 at 8:00 for everyone in Etobicoke.',
  // The checkpoint failure mode, added with the third rung: a booking lead time and a
  // wait, neither of which any payload carries, wrapped around a claim about the child.
  'Maya is behind on her routine visit at 18 months, so book it a few weeks ahead because clinics fill up.',
  // …and the registration date trailing the checkpoint rather than leading it, so the
  // CASCADE gate is calibrated on order and not only on a missing token.
  'Registration for all of that opens at 6:30 anyway.',
  'There is honestly so much going on around you this week that I could barely fit it all in.',
  WATCH_OFFER,
].join(' ');

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const skill = await agent.loadSkill(RADAR_SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  // MEDIAN OF THREE for voice, and it is this rubric that needs it. The two judges pull
  // against each other on the SAME sentence by construction: attribution wants the few
  // words that make Hale the one who looked, and a voice draw in the tail reads those
  // same words as "narrative and inference not in the facts" and returns a 3. Measured
  // when the between-cycles skill edit re-keyed the corpus and forced a full re-sample —
  // four consecutive live runs each failed a DIFFERENT one to three fixtures on a lone
  // voice draw, with no message changing in any way a parent would notice. A single draw
  // was never a measurement here; the committed cache was just a lucky one. The median
  // accepts nothing new (two draws below the floor still fails) and sample zero keeps the
  // historical cache key, so every verdict already committed replays unchanged.
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'radar', cachedOnly, getClient, cost, {
    samples: JUDGE_SAMPLES_MEDIAN,
  });
  // Median of three here too, and for the same measured reason: this rubric's tail reads
  // a perfectly good "I checked X for you" as a 1 about once in twenty draws, and it is a
  // hard floor. It still fails what it should — the broken stand-in states its inventions
  // flat, so all three draws land low — which is what the --broken calibration proves.
  const attributionJudge = makeJudge(
    judgeModel,
    ATTRIBUTION_JUDGE_SYSTEM,
    'radar-attribution',
    cachedOnly,
    getClient,
    cost,
    { samples: JUDGE_SAMPLES_MEDIAN },
  );

  console.log(
    `radar-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${RADAR_FIXTURES.length} decision fixtures\n`);

  const results = [];
  for (const fixture of RADAR_FIXTURES) {
    const context = radarVoiceContext(fixture.decision);
    let message;
    if (broken) {
      message = BROKEN_MESSAGE;
    } else {
      // Replicates runAgent's request for a no-tools skill EXACTLY: the system prompt
      // is the skill body plus the serialized context, and the first user turn is that
      // same serialized context (packages/agent/src/agent.ts buildSystemPrompt /
      // initialUserContent).
      const { text } = await cachedTextCall({
        tag: `radar:compose:${fixture.id}`,
        model,
        system: `${skill.instructions}\n\n## Context\n\n${JSON.stringify(context)}`,
        userMessage: JSON.stringify(context),
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      message = parseRadarVoice(text);
    }

    const score =
      broken || !message ? null : (await judge(fixture.id, { facts: context, message })).score;
    // The attribution judge DOES run in broken mode, unlike the voice judge. It is the
    // only gate here whose teeth are a model's opinion rather than a regex, so "would it
    // fail a message that attributes nothing?" has to be answered by the harness itself
    // and not by whoever last edited the rubric: the broken stand-in states invented facts
    // flat, and a run that scores it >= 4 has a toothless judge, not a passing composer.
    const attribution =
      !message || !carriesAFind(fixture.decision)
        ? null
        : (await attributionJudge(fixture.id, { facts: context, message })).score;
    results.push({
      fixture,
      message,
      score,
      attribution,
      failures: checkMessage(fixture, message, score, attribution),
    });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- compose ---');
  for (const result of results) {
    const ok = result.failures.length === 0;
    const scoreLabel = [
      result.score === null ? '' : `voice=${result.score}`,
      result.attribution === null ? '' : `looked=${result.attribution}`,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${result.fixture.id}${scoreLabel ? `  ${scoreLabel}` : ''}`);
    for (const failure of result.failures) console.log(`        - ${failure}`);
    if (process.argv.includes('--dump')) console.log(`        MSG: ${JSON.stringify(result.message)}`);
  }

  const passes = results.filter((r) => r.failures.length === 0);
  const fabricating = results.filter((r) => r.message && fabrications(r.message, radarVoiceContext(r.fixture.decision)).length > 0);
  const overBudget = results.filter(
    (r) => r.message && smsSegments(payloadOf(r.fixture.decision, r.message)) > MAX_PAYLOAD_SEGMENTS,
  );
  const asking = results.filter((r) => r.message?.includes('?'));
  const scores = results.map((r) => r.score).filter((s) => typeof s === 'number');
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const attributions = results.map((r) => r.attribution).filter((s) => typeof s === 'number');
  const meanAttribution = attributions.length
    ? attributions.reduce((a, b) => a + b, 0) / attributions.length
    : 0;
  const unattributed = results.filter(
    (r) => typeof r.attribution === 'number' && r.attribution < JUDGE_MIN,
  );
  const accuracy = passes.length / results.length;
  const segmentsMean = results
    .filter((r) => r.message)
    .map((r) => smsSegments(payloadOf(r.fixture.decision, r.message)));

  console.log('\n--- corpus metrics ---');
  console.log(`fixtures passing every check: ${(accuracy * 100).toFixed(1)}%  (100% required)`);
  console.log(`FABRICATIONS:                 ${fabricating.length}  (0 required — the hard gate)`);
  console.log(`over the segment budget:      ${overBudget.length}  (0 required)`);
  console.log(`messages asking a question:   ${asking.length}  (0 required — the shell asks)`);
  console.log(`mean voice score:             ${meanScore.toFixed(2)}  (each >= ${JUDGE_MIN})`);
  console.log(
    `finds landing as trivia:      ${unattributed.length}  (0 required — a find with no look behind it)`,
  );
  console.log(
    `mean attribution score:       ${meanAttribution.toFixed(2)}  (each >= ${JUDGE_MIN}, ${attributions.length} finds scored)`,
  );
  if (segmentsMean.length) {
    console.log(
      `segments per payload:         min ${Math.min(...segmentsMean)} / max ${Math.max(...segmentsMean)}`,
    );
  }

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    accuracy === 1 &&
    fabricating.length === 0 &&
    overBudget.length === 0 &&
    asking.length === 0 &&
    unattributed.length === 0;

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
  console.error('radar eval harness error:', err);
  process.exit(2);
});
