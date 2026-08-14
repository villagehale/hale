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
 * Whether this turn has a find to attribute. When all three rungs are null there is
 * nothing Hale found, and the skill hands that turn a mapping line that already says Hale
 * is out looking — scoring it for attribution would fail the honest-absence message for
 * being honest, and would push a second "I checked" onto the one message that must not
 * pad. Mirrors the `emptyHanded` branch in radarVoiceContext above.
 */
function carriesAFind(decision) {
  return (
    decision.weekendPick !== null || decision.registrationLine !== null || decision.checkpoint !== null
  );
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

  const segments = smsSegments(`${message}\n\n${WATCH_OFFER}`);
  if (segments > MAX_PAYLOAD_SEGMENTS) {
    failures.push(`payload is ${segments} SMS segments > ${MAX_PAYLOAD_SEGMENTS}`);
  }

  const sentences = countSentences(message);
  if (sentences > MAX_SENTENCES) {
    failures.push(`${sentences} sentences > ${MAX_SENTENCES}`);
  }

  const lower = message.toLowerCase();
  for (const token of fixture.expect.mustRecall ?? []) {
    if (!lower.includes(token.toLowerCase())) {
      failures.push(`never delivers the fact it exists for: ${JSON.stringify(token)}`);
    }
  }
  // The cascade, checked as ORDER rather than as an opinion: each token must be
  // present and must not appear before the one that outranks it.
  let cursor = -1;
  for (const token of fixture.expect.orderedRecall ?? []) {
    const at = lower.indexOf(token.toLowerCase());
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
  'A LOW score is hype or exclamation marks, brand/corporate voice ("We are excited to"),',
  'listing facts like a database row, restating every field, sounding like an ad, or',
  'any detail not present in the facts. Reply with ONLY the score tool.',
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
  'Score 1 ALSO for the opposite failure - a look with specifics in it. Hale was given no',
  'postal code, no area name, no count of places checked, no time the check ran and no',
  'schedule it runs on, so any of those is invented, and an invented scope is worse than',
  'no attribution at all.',
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
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'radar', cachedOnly, getClient, cost);
  const attributionJudge = makeJudge(
    judgeModel,
    ATTRIBUTION_JUDGE_SYSTEM,
    'radar-attribution',
    cachedOnly,
    getClient,
    cost,
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
  }

  const passes = results.filter((r) => r.failures.length === 0);
  const fabricating = results.filter((r) => r.message && fabrications(r.message, radarVoiceContext(r.fixture.decision)).length > 0);
  const overBudget = results.filter(
    (r) => r.message && smsSegments(`${r.message}\n\n${WATCH_OFFER}`) > MAX_PAYLOAD_SEGMENTS,
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
    .map((r) => smsSegments(`${r.message}\n\n${WATCH_OFFER}`));

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
