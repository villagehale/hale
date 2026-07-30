// VIL-239 · M4 proactive-nudge composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/nudge-voice.md) run through the
// REAL request shape runAgent builds for a no-tools voice skill — REPLICATED here
// rather than imported, for the same reason the radar/intake/sentinel evals replicate:
// the web modules sit behind the `~/` alias, which the tsx loader here cannot resolve.
// The SKILL body and the model routing ARE imported live from packages/agent, so a
// skill edit or a model.ts re-tiering re-keys the cache and shows up here immediately.
//
// What is NOT tested here: the selector and the outbound gate. Both are pure,
// deterministic code with their own vitest suites (apps/web/lib/channel/nudge/
// nudge-decide.test.ts, apps/web/lib/channel/outbound-gate.test.ts) and no model runs in
// either — that is the point of the split. This eval is about the one thing a model does
// in M4: turning a decision object into an UNSOLICITED text message without inventing
// anything. The stakes differ from M3's by one fact: nobody asked for this message, so
// there is no question it was answering to correct a plausible invention.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-nudge-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-nudge-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-nudge-eval.mjs --cached-only                    # CI: replay only
//   ... --show                                                     # print each message
//
// Calibrated BOTH directions: the real cached model clears every gate; the --broken
// stand-in (a composer that invents a venue, a price and a time, writes the opt-out line
// itself, asks a question, and rambles past the segment budget) fails the fabrication
// gate, the opt-out gate, the question gate, the length gate AND the tone judge.

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
import { NUDGE_FIXTURES, NUDGE_OPT_OUT } from './nudge-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const NUDGE_SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'nudge-voice.md');

const MAX_TOKENS = 300;
/** Mirrors MAX_NUDGE_SEGMENTS in apps/web/lib/channel/nudge/nudge-voice.ts. */
const MAX_PAYLOAD_SEGMENTS = 2;
/** The copy contract's hard ceiling. Tighter than the radar's three: this message
 * interrupted someone. */
const MAX_SENTENCES = 2;

// ── replicated: the composer's context shape (nudge-voice.ts nudgeVoiceContext) ──
// The model sees the nudge's FACTS and nothing else — no candidate uuid, no window id.
// This IS the fabrication haystack: anything the message says that is not in here was
// invented.

function townLabel(municipality) {
  return municipality
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function nudgeVoiceContext(nudge) {
  if (nudge.kind === 'registration') {
    return {
      kind: nudge.kind,
      town: townLabel(nudge.windowRef.municipality),
      cycle: nudge.windowRef.cycleLabel,
      opensAtLocal: nudge.opensAtLocal,
      kidNames: nudge.kidNames,
      residentNote: nudge.residentNote,
      ageApproximate: nudge.ageApproximate,
    };
  }
  return {
    kind: nudge.kind,
    what: nudge.candidateRef.title,
    where: nudge.candidateRef.venueName,
    day: nudge.day,
    kidNames: nudge.kidNames,
    weatherFact: nudge.weatherFact,
    whyFacts: nudge.whyFacts,
  };
}

/**
 * Replicates the sweep's order of operations (run.ts runForFamily): the outbound gate
 * FIRST, then the selector, and only then the model. Composing anything for a family
 * that failed either is a spend bug and a CASL bug at once.
 */
function shouldCompose(fixture) {
  return fixture.gateAllowed === true && fixture.nudge !== null;
}

// ── replicated: sms-segments.ts ─────────────────────────────────────────────
// A body that is entirely GSM-7 carries 160 septets alone / 153 per concatenated part;
// one character outside GSM-7 flips the whole body to UCS-2 (70 / 67). The budget is
// what the copy contract is written against, so the gate has to count the same way the
// sender will.

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

function parseNudgeVoice(answer) {
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
// Every proper noun and every number in the message must trace back to the nudge. A
// venue, a price, a date, or a time that appears nowhere in the context is a
// fabrication — and in an unprompted text it arrives with nothing around it to correct.

/** Capitalised words that are not proper nouns about this family's week. */
const ALLOWED_CAPS = new Set(['Hale', 'I', 'A', 'An', 'The', 'And', 'But', 'So', 'If', 'It']);

/**
 * Weekday names get their OWN check, because the capitalised-word heuristic below skips
 * the first word of each sentence (every sentence starts capitalised) — and a sentence
 * that OPENS with an invented day ("Sunday is the backup.") is exactly the fabrication
 * this nudge turns on. Days are a closed set, so they can be checked exhaustively
 * wherever they appear.
 */
const DAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function fabrications(message, context) {
  const hay = JSON.stringify(context).toLowerCase();
  const offenders = [];

  for (const number of message.match(/\d+/g) ?? []) {
    if (!hay.includes(number)) offenders.push(`number "${number}" is in no fact`);
  }
  for (const url of message.match(/https?:\/\/\S+/g) ?? []) {
    offenders.push(`link "${url}" — this skill is never given one`);
  }
  const lower = message.toLowerCase();
  for (const day of DAY_NAMES) {
    if (lower.includes(day) && !hay.includes(day)) offenders.push(`day "${day}" is in no fact`);
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
  if (fixture.expect.neverComposes) {
    return message === null
      ? []
      : ['composed a message for a family the gate or the selector had already ruled out'];
  }

  const failures = [];
  if (!message) return ['answer failed to parse into a strict { message } object'];

  const context = nudgeVoiceContext(fixture.nudge);
  failures.push(...fabrications(message, context));

  if (message.includes(NUDGE_OPT_OUT)) {
    failures.push('writes the opt-out line the sender appends — the parent is told twice');
  }
  if (message.includes('?')) {
    failures.push('asks a question in an unprompted text (nothing here needs an answer)');
  }

  const segments = smsSegments(`${message}\n\n${NUDGE_OPT_OUT}`);
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
  'You are a strict reviewer scoring an UNSOLICITED text message Hale sends a parent.',
  'Nobody asked for it; the phone just buzzed. You are given the FACTS Hale decided on',
  'and the message written from them.',
  'Score VOICE & FAITHFULNESS on a 1-5 integer scale. A 5 earns the interruption: quiet,',
  'plain-spoken, specific, ONE thing, at most two short sentences, and it states only the',
  'given facts. Two shapes are both correct and are scored the same way. When the facts',
  'carry a DEADLINE (a registration date), the message leads with it. When they carry a',
  'WEEKEND SUGGESTION, there is no deadline to lead with: leading with the forecast and',
  'then naming the thing it points to is exactly right, and must not be marked down for',
  'lacking urgency it was never given.',
  'A LOW score is hype or exclamation marks, brand/corporate voice ("We are excited to"),',
  'apologising for texting or explaining why it is texting ("just a quick heads up"),',
  'reciting the facts like a database row, asking a question, sounding like an ad,',
  'inventing urgency or advice, or any detail not present in the facts.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: invents a venue, a price and a time none of which are
// in any fixture's nudge, writes the opt-out line itself, asks a question, and rambles
// past the budget. Every gate must reject it — no API call, no cache read.
const BROKEN_MESSAGE = [
  "Great news! I found Sunnyside Splash Pad for you on Friday, and it's only $14 per child, starting at 9:15 sharp.",
  'You should also know about the Beaches Rec Centre program which opens on September 3 at 8:00 for everyone in Etobicoke.',
  'Want me to book it?',
  NUDGE_OPT_OUT,
].join(' ');

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const skill = await agent.loadSkill(NUDGE_SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'nudge', cachedOnly, getClient, cost);

  console.log(
    `nudge-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${NUDGE_FIXTURES.length} nudge fixtures\n`);

  const results = [];
  for (const fixture of NUDGE_FIXTURES) {
    // The gate and the selector run BEFORE the model. A fixture they rule out never
    // reaches a compose call at all — that is the assertion, and it costs nothing.
    if (!shouldCompose(fixture)) {
      results.push({ fixture, message: null, score: null, failures: checkMessage(fixture, null, null) });
      continue;
    }

    const context = nudgeVoiceContext(fixture.nudge);
    let message;
    if (broken) {
      message = BROKEN_MESSAGE;
    } else {
      // Replicates runAgent's request for a no-tools skill EXACTLY: the system prompt is
      // the skill body plus the serialized context, and the first user turn is that same
      // serialized context (packages/agent/src/agent.ts buildSystemPrompt /
      // initialUserContent).
      const { text } = await cachedTextCall({
        tag: `nudge:compose:${fixture.id}`,
        model,
        system: `${skill.instructions}\n\n## Context\n\n${JSON.stringify(context)}`,
        userMessage: JSON.stringify(context),
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      message = parseNudgeVoice(text);
    }

    const score =
      broken || !message ? null : (await judge(fixture.id, { facts: context, message })).score;
    results.push({ fixture, message, score, failures: checkMessage(fixture, message, score) });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- compose ---');
  for (const result of results) {
    const ok = result.failures.length === 0;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${result.fixture.id}${result.score === null ? '' : `  voice=${result.score}`}`,
    );
    for (const failure of result.failures) console.log(`        - ${failure}`);
    if (process.argv.includes('--show') && result.message) console.log(`        > ${result.message}`);
  }

  const composed = results.filter((r) => r.message);
  const passes = results.filter((r) => r.failures.length === 0);
  const fabricating = composed.filter(
    (r) => fabrications(r.message, nudgeVoiceContext(r.fixture.nudge)).length > 0,
  );
  const overBudget = composed.filter(
    (r) => smsSegments(`${r.message}\n\n${NUDGE_OPT_OUT}`) > MAX_PAYLOAD_SEGMENTS,
  );
  const asking = composed.filter((r) => r.message.includes('?'));
  const optingOut = composed.filter((r) => r.message.includes(NUDGE_OPT_OUT));
  const leaked = results.filter((r) => r.fixture.expect.neverComposes && r.message !== null);
  const scores = results.map((r) => r.score).filter((s) => typeof s === 'number');
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const accuracy = passes.length / results.length;
  const segments = composed.map((r) => smsSegments(`${r.message}\n\n${NUDGE_OPT_OUT}`));

  console.log('\n--- corpus metrics ---');
  console.log(`fixtures passing every check: ${(accuracy * 100).toFixed(1)}%  (100% required)`);
  console.log(`FABRICATIONS:                 ${fabricating.length}  (0 required — the hard gate)`);
  console.log(`composed behind a closed gate:${leaked.length}  (0 required — the CASL gate)`);
  console.log(`over the segment budget:      ${overBudget.length}  (0 required)`);
  console.log(`messages asking a question:   ${asking.length}  (0 required)`);
  console.log(`messages writing the opt-out: ${optingOut.length}  (0 required — the shell appends it)`);
  console.log(`mean voice score:             ${meanScore.toFixed(2)}  (each >= ${JUDGE_MIN})`);
  if (segments.length) {
    console.log(
      `segments per payload:         min ${Math.min(...segments)} / max ${Math.max(...segments)}`,
    );
  }

  console.log('\n--- cost telemetry ---');
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost this run: $${totalUsd(cost).toFixed(4)} USD`,
  );

  const allPass =
    accuracy === 1 &&
    fabricating.length === 0 &&
    leaked.length === 0 &&
    overBudget.length === 0 &&
    asking.length === 0 &&
    optingOut.length === 0;

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
