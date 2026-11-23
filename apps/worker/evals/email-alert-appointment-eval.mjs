// VIL-762 · same appointment, and a real clash (hard rule #8: no LLM mocking).
//
// The subject is the production read (email-alert-appointment.ts) and, when a
// text is owed, the production notice writer with the clash addendum only when
// the read found a clash. The decision is the model's ids. Nothing here matches
// titles or times.
//
// Named without the run- prefix until its one paid recording lands, so the
// every-eval cached-only sweep does not replay an empty cache. When recorded,
// rename to run-email-alert-appointment-eval.mjs and add the CI step.
//
//   node evals/email-alert-appointment-eval.mjs --dry
//   node evals/email-alert-appointment-eval.mjs --cached-only
//   ANTHROPIC_API_KEY_TEST=... HALE_SPEND_LEDGER=... \
//     node evals/email-alert-appointment-eval.mjs --max-usd 2

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { EMAIL_ALERT_APPOINTMENT_FIXTURES } from './email-alert-appointment-fixtures.mjs';
import {
  REPO_ROOT,
  installEvalSpendCap,
  lazyAnthropic,
  makeCost,
  totalUsd,
} from './lib/harness.mjs';
import { cachedLaneToolCall } from './lib/lane-tool-call.mjs';

const WEB_TSCONFIG = join(REPO_ROOT, 'apps', 'web', 'tsconfig.json');
register({ tsconfig: WEB_TSCONFIG });
const importTs = (absPath) => import(pathToFileURL(absPath).href);

const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const APPOINTMENT_SRC = join(
  REPO_ROOT,
  'apps',
  'web',
  'lib',
  'integrations',
  'email-alert-appointment.ts',
);
const NOTICE_SRC = join(REPO_ROOT, 'apps', 'web', 'lib', 'integrations', 'email-alert-notice.ts');
const READ_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'email-alert-appointment.md');
const NOTICE_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'email-alert-notice.md');
const CLASH_SKILL = join(REPO_ROOT, 'packages', 'agent', 'skills', 'email-alert-clash-notice.md');

const CHILDREN = [{ id: 'child-sam', name: 'Sam', ageInMonths: 48 }];
const ZONE = 'America/Toronto';

function extractionOf(fixture) {
  return {
    kind: fixture.kind,
    event: {
      title: fixture.title,
      childRef: fixture.child ? 'child-sam' : null,
      originalTime: fixture.originalTime,
      newTime: fixture.newTime,
      location: fixture.location,
    },
    sourceConfidence: 0.9,
    quoteEvidence: 'the visit',
    teenContent: false,
    teenAttributed: false,
    matchedEventRef: null,
  };
}

function useTestKey() {
  const testKey = process.env.ANTHROPIC_API_KEY_TEST?.trim();
  if (!testKey) {
    console.error('email-alert-appointment: live calls use ANTHROPIC_API_KEY_TEST only');
    process.exit(2);
  }
  const other = process.env.ANTHROPIC_API_KEY;
  if (other && other !== testKey) {
    console.error('email-alert-appointment: refusing a key other than ANTHROPIC_API_KEY_TEST');
    process.exit(2);
  }
  process.env.ANTHROPIC_API_KEY = testKey;
}

function decisionFailures(fixture, judgment) {
  if (judgment.sameAs !== null && judgment.clashes.length > 0) {
    return ['same visit also listed as a clash'];
  }
  if (fixture.expect === 'same') {
    return judgment.sameAs === fixture.sameId ? [] : [`same_as ${judgment.sameAs ?? 'empty'}`];
  }
  if (judgment.sameAs !== null) return [`same_as ${judgment.sameAs}`];
  const clashes = [...judgment.clashes].sort();
  const want = [...(fixture.clashIds ?? [])].sort();
  if (clashes.join('|') !== want.join('|')) return [`clashes ${clashes.join(',') || 'none'}`];
  return [];
}

async function main() {
  const dry = process.argv.includes('--dry');
  const cachedOnly = process.argv.includes('--cached-only');
  if (dry && cachedOnly) {
    console.error('email-alert-appointment: --dry runs alone');
    process.exit(2);
  }
  const agent = await importTs(AGENT_SRC);
  const appointment = await importTs(APPOINTMENT_SRC);
  const notice = await importTs(NOTICE_SRC);
  const readSkill = await agent.loadSkill(READ_SKILL);
  const noticeSkill = await agent.loadSkill(NOTICE_SKILL);
  const clashSkill = await agent.loadSkill(CLASH_SKILL);
  const readLane = agent.pickLane(readSkill.meta.task);
  const noticeLane = agent.pickLane(noticeSkill.meta.task);

  if (dry) {
    console.info(
      `email-alert-appointment | --dry | read=${readLane.model} notice=${noticeLane.model} | fixtures=${EMAIL_ALERT_APPOINTMENT_FIXTURES.length} | no client`,
    );
    return;
  }

  if (!cachedOnly) useTestKey();
  installEvalSpendCap();
  const getClient = lazyAnthropic('email-alert-appointment');
  const cost = makeCost();
  const failures = [];
  const texts = [];

  for (const fixture of EMAIL_ALERT_APPOINTMENT_FIXTURES) {
    const email = appointment.appointmentCandidate({
      extraction: extractionOf(fixture),
      children: CHILDREN,
      timeZone: ZONE,
    });
    const facts = { email, commitments: fixture.commitments };
    const readCall = await cachedLaneToolCall({
      agent,
      lane: readLane,
      tag: `email-alert-appointment:${fixture.id}`,
      system: readSkill.instructions,
      userMessage: appointment.emailAlertAppointmentUserMessage(facts),
      toolName: appointment.EMAIL_ALERT_APPOINTMENT_TOOL,
      toolDescription: appointment.EMAIL_ALERT_APPOINTMENT_TOOL_DESCRIPTION,
      toolSchema: appointment.EMAIL_ALERT_APPOINTMENT_TOOL_SCHEMA,
      maxTokens: appointment.EMAIL_ALERT_APPOINTMENT_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (readCall.miss) {
      failures.push(`${fixture.id}: read unrecorded`);
      continue;
    }
    const read = appointment.readAppointmentJudgment(
      readCall.value,
      new Set(fixture.commitments.map((item) => item.id)),
      fixture.kind,
    );
    if (read.status !== 'judged') {
      failures.push(`${fixture.id}: ${read.reason}`);
      continue;
    }
    const missed = decisionFailures(fixture, read.judgment);
    if (missed.length > 0) {
      failures.push(`${fixture.id}: ${missed.join('; ')}`);
      continue;
    }
    if (fixture.expect === 'same') {
      console.info(`PASS  ${fixture.id}  same, nothing sent`);
      continue;
    }
    const clashes =
      fixture.expect === 'clash'
        ? fixture.commitments
            .filter((item) => read.judgment.clashes.includes(item.id))
            .map(({ id: _id, ...clash }) => clash)
        : undefined;
    const noticeFacts = notice.emailAlertNoticeFacts({
      from: fixture.from,
      subject: fixture.subject,
      kind: fixture.kind === 'booking_confirmation' ? 'new_event' : fixture.kind,
      extraction: extractionOf(fixture),
      children: CHILDREN,
      fromParentsOwnCalendar: false,
      offer: fixture.offer,
      otherHaleFamiliesGoing: null,
      language: 'en',
      recentNotices: [],
      ...(clashes === undefined ? {} : { clashes }),
      durationMinutes: null,
      receivedAt: new Date(fixture.receivedAt),
      timeZone: ZONE,
      now: new Date(fixture.now),
    });
    const system =
      fixture.expect === 'clash'
        ? agent.joinedSystemText(noticeSkill.instructions, [clashSkill.instructions])
        : noticeSkill.instructions;
    const written = await cachedLaneToolCall({
      agent,
      lane: noticeLane,
      tag: `email-alert-appointment-notice:${fixture.id}`,
      system,
      userMessage: notice.emailAlertNoticeUserMessage(noticeFacts),
      toolName: notice.EMAIL_ALERT_NOTICE_TOOL,
      toolDescription: notice.EMAIL_ALERT_NOTICE_TOOL_DESCRIPTION,
      toolSchema: notice.EMAIL_ALERT_NOTICE_TOOL_SCHEMA,
      maxTokens: notice.EMAIL_ALERT_NOTICE_MAX_TOKENS,
      cachedOnly,
      getClient,
      cost,
    });
    if (written.miss) {
      failures.push(`${fixture.id}: notice unrecorded`);
      continue;
    }
    const parsed = notice.emailAlertNoticeOutputSchema.safeParse(written.value);
    if (!parsed.success) {
      failures.push(`${fixture.id}: notice unparsed`);
      continue;
    }
    const answer = notice.readEmailAlertNotice(parsed.data, noticeFacts);
    if (!('notice' in answer) || !answer.notice.send) {
      failures.push(`${fixture.id}: notice not sent`);
      continue;
    }
    texts.push({ id: fixture.id, text: answer.notice.text });
    console.info(`PASS  ${fixture.id}`);
    console.info(`      ${answer.notice.text}`);
  }

  const spent = totalUsd(cost);
  console.info(
    `email-alert-appointment | live API calls this run: ${cost.liveCalls} | $${spent.toFixed(4)}`,
  );
  if (failures.length > 0) {
    for (const line of failures) console.error(`FAIL  ${line}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('email-alert-appointment eval harness error:', err);
  process.exit(1);
});
