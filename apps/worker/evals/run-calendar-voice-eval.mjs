// VIL-249 · the calendar invite's two COMPOSED surfaces (hard rule #8: no LLM mocking).
//
// The subject is the REAL pair of skills — packages/agent/skills/calendar-email-ask.md
// and calendar-invite-note.md — run through the REAL forced-tool-JSON request shape
// apps/web/lib/loop/voice/calendar-invite-voice.ts builds. The request shape and the
// gates are REPLICATED here for the reason the other web-side evals replicate: that
// module sits behind the app's `~/` alias, which the tsx loader cannot resolve. Two
// things are imported LIVE rather than replicated, because a replica would get them
// subtly wrong and they are exactly what the gates turn on: `smsEncoding` (the GSM-7
// table the carrier bill is computed from) and `findInventedFacts` (the fact lint).
// The SKILL bodies and the model routing are imported live too, so a skill edit or a
// model.ts re-tiering re-keys the cache and shows up as a miss rather than as silence.
//
// WHY THIS EVAL EXISTS. Founder doctrine (2026-08-12): no preset message bodies. These
// two surfaces have no fallback copy at all — if the model cannot clear the gates the
// message is DEFERRED and the parent gets nothing. So the gates and the model have to
// be measured together, and a regression in either is a family that stops being asked.
//
// Usage (from apps/worker):
//   node --env-file=../../.env evals/run-calendar-voice-eval.mjs            # live, then caches
//   node --env-file=../../.env evals/run-calendar-voice-eval.mjs --broken   # calibration: must FAIL
//   node evals/run-calendar-voice-eval.mjs --cached-only                    # CI: replay only
//
// THE HARD ZEROS:
//   · gate failures — a draft that trips the composer's own gates is a message that
//     never gets sent, and (for the ask) a family that keeps not being asked.
//   · containment misses — the note must carry the recipient's own redacted summary and
//     the formatted time VERBATIM. This is the redaction check: a composer that
//     paraphrases "an appointment" into "the dentist" has invented a 13+ child's
//     private detail out of nothing (rule #1).
//   · forbidden-pattern hits — a concrete noun in a deliberately vague note, or a first
//     name where the parent's dial says relation.
// Everything else is the judge's bar (JUDGE_MIN per surface): does it sound like Hale,
// does the ask actually ask, is the cancellation matter-of-fact.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ASK_FIXTURES, NOTE_FIXTURES, REFERENCE_ASK } from './calendar-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  cachedToolCall,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  recall,
  totalUsd,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const ASK_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-email-ask.md');
const NOTE_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-invite-note.md');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');
const FACTS_LINT_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'loop', 'voice', 'facts-lint.ts');

// ── the request shapes, replicated from calendar-invite-voice.ts ────────────

const ASK_TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};

const NOTE_TOOL_SCHEMA = {
  type: 'object',
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
  required: ['subject', 'body'],
};

const ASK_MAX_TOKENS = 200;
const NOTE_MAX_TOKENS = 400;

// ── the gates, replicated from calendar-invite-voice.ts ─────────────────────

const MAX_ASK_CHARS = 160;
const MAX_NOTE_SUBJECT_CHARS = 120;
const MAX_NOTE_BODY_CHARS = 320;
const LINK_SHAPE = /https?:\/\/|www\./i;

const tidy = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim();

function askViolations(text, smsEncoding) {
  const out = [];
  if (text === '') out.push('empty');
  if (text.length > MAX_ASK_CHARS) out.push(`over_char_cap (${text.length})`);
  if (smsEncoding(text) !== 'gsm7') out.push('not_gsm7');
  const questions = (text.match(/\?/g) ?? []).length;
  if (questions > 1) out.push(`too_many_questions (${questions})`);
  if (!/email/i.test(text)) out.push('never_says_email');
  if (LINK_SHAPE.test(text)) out.push('carries_link');
  if (text.includes('@')) out.push('carries_at_address');
  if (/\d/.test(text)) out.push('carries_digit');
  return out;
}

function noteViolations(note, context, findInventedFacts) {
  const out = [];
  if (!note.subject.includes(context.summary)) out.push('subject_drops_summary');
  if (!note.body.includes(context.summary)) out.push('body_drops_summary');
  if (!note.body.includes(context.when)) out.push('body_drops_when');
  if (note.subject === '') out.push('subject_empty');
  if (note.body === '') out.push('body_empty');
  if (note.subject.length > MAX_NOTE_SUBJECT_CHARS) out.push(`subject_over_cap (${note.subject.length})`);
  if (note.body.length > MAX_NOTE_BODY_CHARS) out.push(`body_over_cap (${note.body.length})`);
  if (LINK_SHAPE.test(note.subject) || LINK_SHAPE.test(note.body)) out.push('carries_link');
  const slots = [context.summary, context.when];
  const invented = [
    ...findInventedFacts(note.subject, slots),
    ...findInventedFacts(note.body, slots),
  ];
  if (invented.length > 0) out.push(`invented_fact (${[...new Set(invented)].join(', ')})`);
  return out;
}

// ── the judges ───────────────────────────────────────────────────────────────

const JUDGE_ASK = [
  'You are a strict reviewer scoring ONE text message. Hale keeps a family\'s calendar',
  'over SMS, has just put something on it, and can also email a real calendar invite -',
  'but has no email address for anyone in the household. This message is the ONE time',
  'it asks for one; there is no follow-up. Score 1-5.',
  'A 5 does both halves in two clauses: offers to put things in their REAL calendar by',
  'email, and asks them to TEXT their address back. Quiet, plain, first person, no',
  'greeting, no pressure, and fine to ignore.',
  'A LOW score is any of: not actually asking for an address; not saying what they get',
  'for it; pressure, urgency or a deadline; explaining why it helps Hale; a greeting or',
  'the parent\'s name; pointing at an app, a website or a settings page; promising',
  'anything beyond invites; more than about two clauses; hype or an exclamation mark.',
  'You are also given `reference` - the hand-written line this used to be. It is a',
  'yardstick for MEANING and register, NOT a target: a good answer does not have to',
  'resemble it, and copying it is neither a bonus nor a penalty.',
  'Reply with ONLY the score tool.',
].join(' ');

const JUDGE_NOTE = [
  'You are a strict reviewer scoring the SUBJECT and the short NOTE on an email that',
  'carries a calendar invite (an .ics attachment) for one event Hale just put on a',
  'family\'s calendar. Score 1-5.',
  'The writer was given exactly two facts - `summary` (the event, already written for',
  'this reader) and `when` - and NOTHING else. No place, no duration, no cost, no other',
  'people, no second time exist.',
  'A 5 is warm and done in two sentences: it reuses the summary and the time as given,',
  'says the invite is attached and their calendar can add it (or, for a cancellation,',
  'that the attachment takes it back off), and stops.',
  'A LOW score is any of: ANY detail that was not in summary or when - a place, a',
  'duration, what to bring, who else is going, a second time; expanding a deliberately',
  'vague summary into a guess at what the event is; naming a child the summary did not',
  'name; a greeting or sign-off; an instruction to go somewhere or reply; apology; hype;',
  'an exclamation mark; more than two sentences.',
  'Reply with ONLY the score tool.',
].join(' ');

// Deterministic broken stand-ins: each trips several gates AND the judge, so --broken
// proves every layer bites rather than one of them carrying the calibration.
const BROKEN_ASK =
  'Hi there! Add your email at https://villagehale.com/settings (like you@example.com) ' +
  'within 24 hours? Want invites?';
const BROKEN_NOTE = {
  subject: 'Your appointment is confirmed!',
  body: 'Great news - the dentist at 9:45 AM is booked and the invite is attached. Bring a health card and check https://villagehale.com for details.',
};

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const getClient = lazyAnthropic();
  const cost = makeCost();

  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsEncoding } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  const { findInventedFacts } = await tsImport(FACTS_LINT_SRC, import.meta.url);
  const askSkill = await agent.loadSkill(ASK_SKILL);
  const noteSkill = await agent.loadSkill(NOTE_SKILL);
  const askModel = agent.pickModel(askSkill.meta.task);
  const noteModel = agent.pickModel(noteSkill.meta.task);
  const judgeModel = await readJudgeModel();
  const judgeAsk = makeJudge(judgeModel, JUDGE_ASK, 'calendar-ask', cachedOnly, getClient, cost);
  const judgeNote = makeJudge(judgeModel, JUDGE_NOTE, 'calendar-note', cachedOnly, getClient, cost);

  console.log(
    `calendar-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | ask=${askModel} note=${noteModel} judge=${judgeModel}`,
  );
  console.log(`corpus: ${ASK_FIXTURES.length} asks + ${NOTE_FIXTURES.length} notes\n`);

  const results = [];

  for (const fixture of ASK_FIXTURES) {
    const userMessage = JSON.stringify(fixture.turn);
    const raw = broken
      ? BROKEN_ASK
      : (
          await cachedToolCall({
            tag: `calendar-ask:${fixture.id}`,
            model: askModel,
            system: askSkill.instructions,
            userMessage,
            toolName: 'ask',
            toolSchema: ASK_TOOL_SCHEMA,
            toolDescription: 'Return the one text asking this family for an email address.',
            maxTokens: ASK_MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.text;

    const text = tidy(raw);
    const failures = askViolations(text, smsEncoding);
    const verdict = await judgeAsk(fixture.id, {
      ask: text,
      reference: REFERENCE_ASK,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ surface: 'ask', id: fixture.id, rendered: text, failures });
  }

  for (const fixture of NOTE_FIXTURES) {
    const userMessage = JSON.stringify(fixture.context);
    const value = broken
      ? BROKEN_NOTE
      : (
          await cachedToolCall({
            tag: `calendar-note:${fixture.id}`,
            model: noteModel,
            system: noteSkill.instructions,
            userMessage,
            toolName: 'note',
            toolSchema: NOTE_TOOL_SCHEMA,
            toolDescription: 'Return the subject line and the short note above the invite.',
            maxTokens: NOTE_MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value;

    const note = { subject: tidy(value.subject), body: tidy(value.body) };
    const failures = noteViolations(note, fixture.context, findInventedFacts);
    const both = `${note.subject}\n${note.body}`;
    for (const pattern of fixture.forbiddenPatterns ?? []) {
      if (pattern.test(both)) failures.push(`forbidden:${pattern.source}`);
    }
    if (recall(both, fixture.mustRecall) < 1) failures.push('recall_miss');

    const verdict = await judgeNote(fixture.id, {
      given: fixture.context,
      subject: note.subject,
      body: note.body,
      watchFor: fixture.watchFor,
    });
    if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    results.push({ surface: 'note', id: fixture.id, rendered: `${note.subject} | ${note.body}`, failures });
  }

  // ── report ─────────────────────────────────────────────────────────────────
  console.log('--- drafts ---');
  for (const r of results) {
    const tag = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.surface.padEnd(4)} ${r.id.padEnd(24)} "${r.rendered.slice(0, 96)}"`);
    for (const f of r.failures) console.log(`      · ${f}`);
  }

  const gateFails = results.filter((r) =>
    r.failures.some((f) => !f.startsWith('judge:') && !f.startsWith('forbidden:')),
  );
  const containment = results.filter((r) =>
    r.failures.some(
      (f) => f.startsWith('subject_drops') || f.startsWith('body_drops') || f === 'recall_miss',
    ),
  );
  const invented = results.filter((r) =>
    r.failures.some((f) => f.startsWith('invented_fact') || f.startsWith('forbidden:')),
  );
  const judgeFails = results.filter((r) => r.failures.some((f) => f.startsWith('judge:')));

  console.log('\n--- corpus metrics ---');
  console.log(`GATE FAILURES:           ${gateFails.length}  (0 required - a gated-out draft is a message never sent)`);
  console.log(`containment misses:      ${containment.length}  (0 required - the redacted summary + time must survive verbatim)`);
  console.log(`invented specifics:      ${invented.length}  (0 required - rule #1)`);
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
  console.error('calendar-voice eval harness error:', err);
  process.exit(2);
});
