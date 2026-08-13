// VIL-229 · the reminder voice composer eval (hard rule #8: no LLM mocking).
//
// The subject is the REAL skill (packages/agent/skills/reminder-voice.md) run through the
// REAL runAgent request shape apps/web/lib/loop/voice/reminder-voice.ts builds via
// composeVoice — a no-tools voice skill, one step, the serialized redacted context as the
// single user turn, and a JSON answer parsed out of free text. The SKILL body and the
// model routing are imported live from packages/agent, so a skill edit or a model.ts
// re-tiering re-keys the cache and shows up here as a miss rather than as silence.
// `findInventedFacts` is imported LIVE rather than replicated (as the calendar-voice eval
// imports it) because it is exactly the gate a replica would get subtly wrong, and
// because it is the thing standing between a parent and a wrong appointment time.
//
// WHY THIS EVAL EXISTS. It did not, until the 2026-08-13 tone audit went looking: of the
// composed surfaces in this product the reminder was the only one with NO eval at all,
// and therefore the only one where a skill edit, a model re-tier or a quiet regression
// would reach families with nothing to catch it. It is also the surface with the highest
// read rate — the message that arrives the evening before something, on a lock screen —
// and one of two that carry a redacted teen item as a matter of routine.
//
// FAIL-OPEN IS NOT A SAFETY NET HERE, it is the thing being measured. composeVoice
// degrades to the deterministic line on any parse failure or invented fact, so a bad
// line never reaches a parent — which means the failure mode is not a wrong email, it is
// an email that quietly stopped being written by anybody. A suite that only checked
// safety would score a permanently degraded composer as perfect.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-reminder-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-reminder-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-reminder-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · unusable lines — anything composeVoice would throw away (a non-object answer, an
//     extra key, an invented time or link). Each one is a degrade, and a suite of them is
//     a stage paying for a model and shipping a template.
//   · a clock time — the shell renders the time in large type directly beneath this line.
//     A line that restates it is redundant at best and contradicts the shell at worst,
//     and the skill forbids it outright.
//   · a resolved generic — "an appointment" turned into a dentist, a therapist or a
//     checkup. That is a 13+ child's private detail invented out of nothing (rule #1).
//   · a one-template corpus — five reminders that are one sentence with the nouns
//     swapped. A busy family gets several of these a week.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { REMINDER_VOICE_FIXTURES } from './reminder-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';
import { skillSampleSentences, variationGate, variationLines } from './lib/variation.mjs';
import { cachedAgentAnswer } from './lib/voice-agent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SKILL_PATH = join(REPO_ROOT, 'packages', 'agent', 'skills', 'reminder-voice.md');
const FACTS_LINT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'loop', 'voice', 'facts-lint.ts');

/** Mirrors VOICE_MAX_TOKENS in reminder-voice.ts. */
const MAX_TOKENS = 150;

/** Five reminders, at least three ways of opening one. A parent with a full week gets
 * several of these days apart, so this is the corpus where repetition is actually SEEN —
 * unlike the once-ever surfaces, where convergence is only a doctrine problem. */
const MIN_DISTINCT_OPENERS = 3;

/** A clock time, in the shape the fact lint and the shell both use. The skill's rule is
 * absolute here rather than slot-relative: even the CORRECT time is forbidden, because
 * the shell prints it in large type immediately below this line. */
const CLOCK_TIME = /\b\d{1,2}:\d{2}\b/;

// ── replicated: composeVoice's parse (apps/web/lib/loop/voice/compose.ts) ────
// firstJsonObject + a STRICT object with exactly one key. Replicated rather than
// imported because compose.ts pulls in the database and telemetry modules behind the
// app's `~/` alias; the parse itself is ten lines and is the whole contract.

/** The first balanced `{…}` object literal in a string, or null. */
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

/** Mirrors `parseReminderVoiceAnswer` + the strict zod schema: exactly `{ line: string }`,
 * an extra or unknown key fails the parse and the caller degrades. */
function parseReminderVoiceAnswer(answer) {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'line') return null;
  return typeof value.line === 'string' ? value.line.trim() : null;
}

/** Mirrors `reminderVoiceFactSlots`: every event's redacted descriptor and its time
 * label. This IS the grounding set — anything time- or link-shaped outside it is a
 * fabrication and composeVoice degrades. */
function factSlots(context) {
  return context.events.flatMap((event) => [event.what, event.when]);
}

// ── the judge ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE short line Hale wrote for a reminder EMAIL - the',
  'note the evening before a family event, or about an hour ahead of it. Score 1-5.',
  'The email around this line is already built and is NOT yours to score: it prints each',
  'event and its time in large type directly beneath the line. So the line adds warmth',
  'and nothing else. It is the only part a person wrote.',
  'You are given `offset` ("-P1D" is the evening before, "-PT1H" is about an hour out),',
  'the already-redacted `events` the writer could see, the line, and watchFor -',
  'fixture-specific notes.',
  'A 5 is one short calm sentence that a friend who keeps your calendar would send:',
  'it frames what is coming without restating the time, it sounds like a person rather',
  'than a notification, and it stops.',
  'A LOW score is any of: restating a clock time; hype or exclamation marks ("Big day',
  'tomorrow!!"); anything the writer was not given - a place, a duration, what to bring,',
  'who else is going, how long the drive is, how the event will go; advice, medical or',
  'otherwise; guessing what a deliberately generic item ("an appointment") actually is,',
  'or remarking on it at all; telling the parent to prepare, pack or leave; a greeting or',
  'a sign-off; more than one sentence; anything longer than a glance.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-in: restates a time, resolves the generic into a dentist,
// invents a place and a duration, hypes, and runs long — trips the clock-time gate, the
// generic-guess gate, the fact lint AND the judge, so `--broken` proves every layer bites
// rather than one of them carrying the calibration.
const BROKEN_LINE =
  "Big day tomorrow!! Don't forget the dentist at 3:45 over at the Bloor West clinic - " +
  'it usually runs about 45 minutes, so leave by 3:15 and bring her health card.';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { findInventedFacts } = await tsImport(FACTS_LINT_SRC, import.meta.url);
  const skill = await agent.loadSkill(SKILL_PATH);
  const samples = await skillSampleSentences(SKILL_PATH);
  const model = agent.pickModel(skill.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(judgeModel, JUDGE_SYSTEM, 'reminder-voice', cachedOnly, getClient, cost);

  console.log(
    `reminder-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | compose=${model} judge=${judgeModel}`,
  );
  console.log(`corpus: ${REMINDER_VOICE_FIXTURES.length} reminders\n`);

  const results = [];
  for (const fixture of REMINDER_VOICE_FIXTURES) {
    const slots = factSlots(fixture.context);
    let line;
    if (broken) {
      line = BROKEN_LINE;
    } else {
      const answer = await cachedAgentAnswer({
        tag: `reminder-voice:${fixture.id}`,
        agent,
        skill,
        context: fixture.context,
        maxTokens: MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      line = parseReminderVoiceAnswer(answer);
    }

    const failures = [];
    if (line === null || line === '') {
      failures.push('degraded: the answer never parsed into a strict { line } object');
    } else {
      const invented = findInventedFacts(line, slots);
      if (invented.length > 0) failures.push(`degraded: invented ${invented.join(', ')}`);
      if (CLOCK_TIME.test(line)) failures.push('restates a clock time the shell already prints');
      const first = line.charAt(0);
      if (first === first.toLowerCase() && first !== first.toUpperCase()) {
        failures.push('opens lower case (one person, one voice - sentence case everywhere)');
      }
      for (const word of fixture.forbiddenWords ?? []) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(line)) {
          failures.push(`resolves the generic item into ${JSON.stringify(word)} (rule #1)`);
        }
      }
    }

    const verdict =
      broken || line === null || line === ''
        ? null
        : await judge(fixture.id, {
            offset: fixture.context.offset,
            events: fixture.context.events,
            line,
            watchFor: fixture.watchFor,
          });
    if (verdict && verdict.score < JUDGE_MIN) {
      failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }

    results.push({ fixture, line, failures });
  }

  const usable = results.filter((r) => r.line !== null && r.line !== '');
  const variation = variationGate({
    items: usable.map((r) => ({ id: r.fixture.id, text: r.line })),
    samples,
    minDistinctOpeners: MIN_DISTINCT_OPENERS,
  });
  for (const result of usable) {
    result.failures.push(...(variation.failuresById[result.fixture.id] ?? []));
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- lines ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.fixture.id.padEnd(26)} "${r.line ?? '(unparseable)'}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const degraded = results.filter((r) => r.failures.some((f) => f.startsWith('degraded')));
  const clockTimes = results.filter((r) =>
    r.failures.some((f) => f.startsWith('restates a clock time')),
  );
  const resolvedGeneric = results.filter((r) => r.failures.some((f) => f.startsWith('resolves')));
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));

  console.log('\n--- corpus metrics ---');
  console.log(
    `DEGRADED lines:          ${degraded.length}  (0 required - a degrade is the deterministic copy with a model's bill in front of it)`,
  );
  console.log(
    `restated clock times:    ${clockTimes.length}  (0 required - the shell prints it big, right below)`,
  );
  console.log(`resolved generics:       ${resolvedGeneric.length}  (0 required - rule #1)`);
  for (const line of variationLines(variation)) console.log(line);
  console.log(`judge below ${JUDGE_MIN}:           ${judgeFails.length}  (0 required)`);

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
  console.error('reminder-voice eval harness error:', err);
  process.exit(2);
});
