// The calendar-invite WRITER · composer eval (hard rule #8: no LLM mocking). VIL-596.
//
// The subject is the REAL skill (packages/agent/skills/calendar-invite-voice.md) run
// through the REAL forced-tool-JSON request shape apps/web/lib/loop/voice/calendar-invite-voice.ts
// builds, REPLICATED here because that module sits behind the web app's `~/` alias.
// `userMessage`, `refusals` and `zonedStart` below are the replicas, and
// calendar-invite-voice.test.ts pins the originals. The destination gate is not
// replicated: calendar-destination.ts has no `~/` imports, so it is loaded as is. The skill bodies and model routing are
// imported live, so a skill edit re-keys the cache and shows up as a miss.
//
// Each reply goes through what production does before a send: the code gate (one slot,
// no other destination, no invented digit, the segment bound), then the REAL time judge
// (calendar-invite-time.md: names this event, in any language, at this start). A reply
// the code gate refuses is not judged, as in production. A Haiku reviewer then scores
// it against the skill (nothing invented, the facts carried).
//
//   node evals/run-calendar-invite-voice-eval.mjs --cached-only            # CI: replay only
//   node evals/run-calendar-invite-voice-eval.mjs --broken --cached-only   # calibration: must FAIL
//   HALE_SPEND_LEDGER=... node evals/run-calendar-invite-voice-eval.mjs --dry
//   HALE_SPEND_LEDGER=... HALE_MAX_USD=1 node --env-file=../../.env evals/run-calendar-invite-voice-eval.mjs --live

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { CALENDAR_INVITE_VOICE_FIXTURES } from './calendar-invite-voice-fixtures.mjs';
import {
  JUDGE_MIN,
  assertRunFlags,
  cachedToolCall,
  dryReportLine,
  installEvalSpendCap,
  isDryRun,
  lazyAnthropic,
  makeCost,
  makeJudge,
  readJudgeModel,
  totalUsd,
} from './lib/harness.mjs';

assertRunFlags(['--broken']);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const SMS_SEGMENTS_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'channel', 'sms-segments.ts');
const DESTINATION_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'loop',
  'voice',
  'calendar-destination.ts',
);
const WRITER_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-invite-voice.md');
const TIME_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'calendar-invite-time.md');

const SLOT = '[[link]]';
const ICS_URL = `https://app.villagehale.com/api/ics/event/${'a'.repeat(36)}.${'b'.repeat(43)}`;

/** Mirrors calendar-invite-voice.ts. */
const WRITER_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const WRITER_MAX_TOKENS = 500;
const TIME_SCHEMA = {
  type: 'object',
  properties: { reason: { type: 'string' }, match: { type: 'boolean' } },
  required: ['reason', 'match'],
};
const TIME_MAX_TOKENS = 300;
const MAX_INVITE_SEGMENTS = 5;

/** Mirrors `calendarInviteUserMessage`. */
function userMessage(request) {
  return JSON.stringify({
    summary: request.summary,
    when: request.when,
    language: request.language,
    linkSlot: SLOT,
  });
}

/** Mirrors `zonedStart`. */
function zonedStart(startsAt, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(startsAt);
  const num = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour'),
    minute: num('minute'),
    weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
  };
}

/** Mirrors `startNumbers`. */
function startNumbers(starts) {
  const numbers = new Set();
  const hour12 = starts.hour % 12 || 12;
  for (const n of [starts.year, starts.month, starts.day, starts.hour, hour12, starts.minute]) {
    numbers.add(String(n));
    numbers.add(String(n).padStart(2, '0'));
  }
  return numbers;
}

/** Mirrors `destinationNumbers`. */
function destinationNumbers(starts) {
  const numbers = startNumbers(starts);
  numbers.add(String(starts.year - 1));
  numbers.add(String(starts.year + 1));
  return numbers;
}

/** Mirrors `calendarInviteRefusals`. */
function refusals(body, request, starts, smsSegments, textDestination) {
  if (body === '') return ['empty'];
  const found = [];
  const slotCount = body.split(SLOT).length - 1;
  if (slotCount === 0) found.push('link_missing');
  if (slotCount > 1) found.push('link_repeated');
  const carriesLink =
    textDestination(body.split(SLOT).join(' '), destinationNumbers(starts)) !== null;
  if (carriesLink) found.push('carries_destination');
  const allowed = startNumbers(starts);
  for (const n of request.summary.match(/\d+/g) ?? []) allowed.add(n);
  const rest = body.split(request.summary).join(' ').split(SLOT).join(' ');
  if ((rest.match(/\d+/g) ?? []).some((n) => !allowed.has(n))) found.push('invented_number');
  if (slotCount === 1 && !carriesLink && /\[\[[^\]]*\]\]/.test(body.replace(SLOT, ''))) {
    found.push('stray_slot');
  }
  if (smsSegments(body.replace(SLOT, ICS_URL)) > MAX_INVITE_SEGMENTS) found.push('too_long');
  return found;
}

const JUDGE_SYSTEM = [
  'You are a strict reviewer scoring ONE text Hale sends a parent who just said yes to an',
  'event: it carries one tap-to-add link (written as the placeholder [[link]]). Hale was',
  'handed the event summary, its time and the language, nothing else. You are given the',
  'request, the message, and watchFor notes. Score 1-5.',
  'A 5 is in the requested language, names the event by its summary (as given or',
  'translated), says when it is, and gets across, in any words, that Hale has noted it',
  'and that opening the link adds it to their calendar. Score meaning, not wording: no',
  'phrase is required, and "in your plans" is not "already on your calendar".',
  'A LOW score is any of: a place, price, person or reason not handed; anything about a',
  'child beyond the summary; a promise of a later text or check; saying it is already on',
  'their phone calendar before they open the link; the wrong language; a web address',
  'other than the placeholder.',
  'Reply with ONLY the score tool.',
].join(' ');

const BROKEN = 'Sign up now at swimfun.example!! Starts 5pm, see you there [[link]] [[link]]';

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  installEvalSpendCap();
  const getClient = lazyAnthropic('calendar-invite-voice');
  const cost = makeCost();
  const agent = await tsImport(AGENT_SRC, import.meta.url);
  const { smsSegments } = await tsImport(SMS_SEGMENTS_SRC, import.meta.url);
  const { textDestination } = await tsImport(DESTINATION_SRC, import.meta.url);
  const writer = await agent.loadSkill(WRITER_SKILL);
  const time = await agent.loadSkill(TIME_SKILL);
  const writerModel = agent.pickModel(writer.meta.task);
  const timeModel = agent.pickModel(time.meta.task);
  const judgeModel = await readJudgeModel();
  const judge = makeJudge(
    judgeModel,
    JUDGE_SYSTEM,
    'calendar-invite-voice',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `calendar-invite-voice eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : isDryRun() ? ' (dry)' : ''} | compose=${writerModel} time=${timeModel} judge=${judgeModel}`,
  );
  const results = [];
  for (const fixture of CALENDAR_INVITE_VOICE_FIXTURES) {
    const { request } = fixture;
    const starts = zonedStart(new Date(request.startsAt), request.timeZone);
    const message = userMessage(request);
    const raw = broken
      ? BROKEN
      : (
          await cachedToolCall({
            tag: `calendar-invite-voice:${fixture.id}`,
            model: writerModel,
            lane: agent.pickLane(writer.meta.task),
            system: writer.instructions,
            userMessage: message,
            toolName: 'calendar_invite',
            toolSchema: WRITER_SCHEMA,
            toolDescription:
              'Return the text Hale sends, with the link placeholder where the tap-to-add link goes.',
            maxTokens: WRITER_MAX_TOKENS,
            cachedOnly,
            getClient,
            cost,
          })
        ).value.text;
    const body = String(raw).trim();
    const failures = refusals(body, request, starts, smsSegments, textDestination);
    // --dry prices both judges even on the stand-in reply the code gate refuses.
    if (failures.length === 0 || isDryRun()) {
      const { value } = await cachedToolCall({
        tag: `calendar-invite-voice:time:${fixture.id}`,
        model: timeModel,
        lane: agent.pickLane(time.meta.task),
        system: time.instructions,
        userMessage: JSON.stringify({
          text: body,
          summary: request.summary,
          when: request.when,
          timeZone: request.timeZone,
          language: request.language,
          starts,
        }),
        toolName: 'time_match',
        toolSchema: TIME_SCHEMA,
        toolDescription:
          'Whether the text names this event and states the same start as the facts.',
        maxTokens: TIME_MAX_TOKENS,
        cachedOnly,
        getClient,
        cost,
      });
      if (value.match !== true) failures.push(`time_judge:false (${value.reason})`);
      const verdict = await judge(fixture.id, {
        request: message,
        message: body,
        watchFor: fixture.watchFor,
      });
      if (verdict.score < JUDGE_MIN) failures.push(`judge:${verdict.score} (${verdict.reason})`);
    }
    results.push({ fixture, body, failures });
  }

  for (const r of results) {
    console.log(
      `${r.failures.length === 0 ? 'PASS' : 'FAIL'}  ${r.fixture.id.padEnd(22)} "${r.body.slice(0, 110)}"`,
    );
    for (const f of r.failures) console.log(`      · ${f}`);
  }
  console.log(
    `live API calls this run: ${cost.liveCalls} | estimated cost: $${totalUsd(cost).toFixed(4)} USD`,
  );
  if (isDryRun()) {
    console.log(dryReportLine('calendar-invite-voice', [judge.plan]));
    process.exit(0);
  }
  const allPass = results.every((r) => r.failures.length === 0);
  if (!broken) process.exit(allPass ? 0 : 1);
  console.log(`broken-mode calibration (must fail): ${allPass ? 'FAIL' : 'PASS'}`);
  process.exit(allPass ? 1 : 0);
}

main().catch((err) => {
  console.error('calendar-invite-voice eval harness error:', err);
  process.exit(2);
});
