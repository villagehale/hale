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

function radarVoiceContext(decision) {
  const pick = decision.weekendPick;
  const reg = decision.registrationLine;
  return {
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

function fabrications(message, context) {
  const hay = JSON.stringify(context).toLowerCase();
  const offenders = [];

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

function countSentences(message) {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

function checkMessage(fixture, message, judgeScore) {
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
  for (const token of fixture.expect.forbidden ?? []) {
    if (lower.includes(token.toLowerCase())) {
      failures.push(`says ${JSON.stringify(token)}, which no fact supports`);
    }
  }

  if (judgeScore !== null && !(judgeScore >= JUDGE_MIN)) {
    failures.push(`voice score ${judgeScore} < ${JUDGE_MIN}`);
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

// Deterministic broken stand-in: invents a venue, a price and a time none of which are
// in any fixture's decision, re-asks the watch question, and rambles past the budget.
// Every gate must reject it — no API call, no cache read.
const BROKEN_MESSAGE = [
  "Great news! I found Sunnyside Splash Pad for you on Friday, and it's only $14 per child, starting at 9:15 sharp.",
  'You should also know about the Beaches Rec Centre program which opens on September 3 at 8:00 for everyone in Etobicoke.',
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
    results.push({ fixture, message, score, failures: checkMessage(fixture, message, score) });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- compose ---');
  for (const result of results) {
    const ok = result.failures.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${result.fixture.id}${result.score === null ? '' : `  voice=${result.score}`}`);
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
    accuracy === 1 && fabricating.length === 0 && overBudget.length === 0 && asking.length === 0;

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
