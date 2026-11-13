import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { loadWeekdayCare } from '~/lib/care/weekday';
import { f14EnabledFor } from '~/lib/channel/f14';
import {
  type FamilyTextRecipient,
  TEXTABLE_ROLES,
  loadFamilyTextRecipients,
} from '~/lib/channel/family-recipients';
import {
  type OutboundGatePorts,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type CandidateDraft, queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import {
  SCHOOL_BREAK_ASK_TEMPLATE_KEY,
  schoolBreakAskDedupeKey,
} from '~/lib/channel/weekday-care/key';
import { DEFAULT_TIMEZONE, dayKeyOf } from '~/lib/format/datetime';
import { zonedLocalInstant } from '~/lib/plan/spine';
import { lastAskDay, schoolYearOf } from './cycle';
import { type SchoolBreakFact, loadSchoolBreak, recordSchoolBreak } from './facts';
import { schoolBreakEnabled } from './flag';
import { type BoardLookupDeps, lookupBoardBreak } from './lookup';
import {
  type VerifiedBreakReading,
  createLiveBreakPageReader,
  createLiveTextBreakReader,
} from './read';
import {
  type SchoolMailReader,
  type SchoolMessage,
  productionSchoolMailPorts,
  schoolMailReader,
} from './school-mail';
import { searchSchoolCalendar } from './search';
import {
  MAX_LOOKUP_TRIES,
  type StoredBoardReading,
  latestBoardReading,
  recordBoardReading,
  recordUnfinishedLookup,
  unfinishedLookups,
} from './store';

/**
 * VIL-685 · the hourly winter-break sweep. For every family Hale texts that has a child
 * of school age (the school year they turn four through the one they turn eighteen) who
 * the parent has not said is at daycare:
 *
 *   1. A parent's own answer stands, and nothing here touches it.
 *   2. Otherwise, THE SCHOOL, named only by the family's own kid mail: the email alerts
 *      Hale already sent them, from senders Gmail says the message authenticated as
 *      (school-mail.ts, sender.ts). That host's own calendar page is looked up (cached per
 *      host, `school_break_readings`) and a verified break is written to the family's fact
 *      with its page and quotes. No host list, and no two schools assumed alike: a host is
 *      read on its own page or not at all, and two schools that give different days are
 *      never settled by picking one: the parent is asked.
 *   3. Otherwise, THE SCHOOL'S OWN EMAIL: with no page giving the days, the text of those
 *      same messages is read for the break, every day quoted from the email.
 *   4. Otherwise, ASK ONCE: one `school_break_ask` candidate per family per school year
 *      goes to the proactive decider. The decider decides whether and when, its writer
 *      words it, and the outbound gate keeps it in the parent's daytime. The reply is read
 *      in the router (GATE 2c-bis).
 *
 * A daycare-only family is never here: its closures come only from the parent's own reply.
 * The break question itself ("winter break is coming, want me to find something?") is
 * the nudge sweep's verified-break rung, which reads the fact this writes.
 */

/** Lookups one run may start: an infra bound on the function's 300 s wall (one lookup is a
 * search turn and up to three page reads). A host left over is looked up next hour. */
export const MAX_BOARD_LOOKUPS_PER_RUN = 3;
/** Families whose mail one run may read (two headers per alert): an infra bound on the
 * same wall. The families served longest ago go first, so a family left over is first
 * next hour. */
export const MAX_MAIL_READS_PER_RUN = 5;
/** Email texts read for one family when no page gave the days: its newest kid mail. */
export const MAX_EMAIL_TEXTS_PER_FAMILY = 3;
/** A family's mail, once read and settled, is not read again for this long. Freshness of
 * a cache, not a send rule. */
export const MAIL_REREAD_MS = 24 * 60 * 60_000;
export const SCHOOL_BREAK_MAIL_SWEEP = 'school_break_mail';
/** When a family's mail was last read at all, settled or not: who is served next. */
export const SCHOOL_BREAK_MAIL_SERVED_SWEEP = 'school_break_mail_served';
/** Junior kindergarten starts in September of the year a child turns four. */
const JK_START_AGE = 4;
/** Grade 12 starts in September of the year a child turns seventeen, and they turn
 * eighteen during it: the last school year with a winter break of theirs. */
const LAST_SCHOOL_YEAR_START_AGE = 17;

export const SCHOOL_BREAK_ASK_KIND = 'school_break_ask' as const;

export interface SchoolBreakSweepResult {
  skipped: 'flag_off' | null;
  families: number;
  f14Dark: number;
  /** No child of school age who is not at daycare: there is no school break to find. */
  noSchoolChild: number;
  /** The parent gave the days; left alone. */
  parentKnown: number;
  /** Families whose kid mail was read this run. */
  mailRead: number;
  /** Mail was there and could not be read (token, Google): the family is asked instead. */
  mailUnread: number;
  /** Messages whose From domain did not authenticate: named no school. */
  unaligned: number;
  lookedUp: number;
  verified: number;
  notFound: number;
  /** A lookup did not finish; it is tried again next hour. */
  retry: number;
  /** A host's lookups ran out of tries: it is `not_found` and its families are asked. */
  retriesExhausted: number;
  /** School emails whose text was read for the break. */
  emailRead: number;
  noClient: number;
  deferred: number;
  /** Facts written or moved to a new reading. */
  recorded: number;
  /** A school is still waiting on a lookup: no ask yet. */
  waiting: number;
  /** Two schools gave different days: nothing filed, the parent is asked. */
  disagreed: number;
  /** The ask's window for this school year has passed. */
  tooLate: number;
  asked: number;
  held: number;
  queued: number;
  failed: number;
}

function emptyResult(skipped: SchoolBreakSweepResult['skipped']): SchoolBreakSweepResult {
  return {
    skipped,
    families: 0,
    f14Dark: 0,
    noSchoolChild: 0,
    parentKnown: 0,
    mailRead: 0,
    mailUnread: 0,
    unaligned: 0,
    lookedUp: 0,
    verified: 0,
    notFound: 0,
    retry: 0,
    retriesExhausted: 0,
    emailRead: 0,
    noClient: 0,
    deferred: 0,
    recorded: 0,
    waiting: 0,
    disagreed: 0,
    tooLate: 0,
    asked: 0,
    held: 0,
    queued: 0,
    failed: 0,
  };
}

export interface SchoolBreakSweepDeps {
  /** Null when this deploy has no model client: due schools are counted as `noClient`. */
  lookup: BoardLookupDeps | null;
  /** The schools the kid mail Hale already alerted on authenticated as, and its text. */
  schoolMail: SchoolMailReader;
  buildGate(database: Database): OutboundGatePorts;
  queueCandidate(database: Database, draft: CandidateDraft): Promise<'queued' | 'duplicate'>;
  f14For(familyId: string): boolean;
  recipients(database: Database, familyId: string): Promise<FamilyTextRecipient[]>;
}

export function boardLookupDeps(client: AgentClient): BoardLookupDeps {
  return {
    search: (officialHost, schoolYear) => searchSchoolCalendar(client, officialHost, schoolYear),
    read: createLiveBreakPageReader(client),
    readText: createLiveTextBreakReader(client),
  };
}

export function defaultSchoolBreakSweepDeps(
  database: Database,
  client: AgentClient | null,
): SchoolBreakSweepDeps {
  return {
    lookup: client ? boardLookupDeps(client) : null,
    schoolMail: schoolMailReader(productionSchoolMailPorts(database)),
    buildGate: buildOutboundGatePorts,
    queueCandidate: queueCheckInForDecider,
    f14For: f14EnabledFor,
    recipients: loadFamilyTextRecipients,
  };
}

/** Every family Hale texts, the one whose mail was served longest ago (or never) first. */
async function loadFamilies(database: Database): Promise<string[]> {
  const members = schema.familyMembers;
  const marks = schema.familySweepMarks;
  const rows = await database
    .selectDistinct({ familyId: members.familyId, servedAt: marks.sweptAt })
    .from(members)
    .leftJoin(
      marks,
      and(eq(marks.familyId, members.familyId), eq(marks.sweep, SCHOOL_BREAK_MAIL_SERVED_SWEEP)),
    )
    .where(inArray(members.role, [...TEXTABLE_ROLES]))
    .orderBy(sql`${marks.sweptAt} asc nulls first`, members.familyId);
  return rows.map((row) => row.familyId);
}

/** A child of school age this school year whose parent has not said they are at daycare. */
async function hasSchoolAgeChild(
  database: Database,
  familyId: string,
  schoolYear: string,
): Promise<boolean> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const startYear = Number(schoolYear.slice(0, 4));
  const atDaycare = new Set(
    (await loadWeekdayCare(database, familyId))
      .filter((fact) => fact.care === 'daycare')
      .map((fact) => fact.childId),
  );
  return children.some((child) => {
    const age = startYear - Number(child.dateOfBirth.slice(0, 4));
    return age >= JK_START_AGE && age <= LAST_SCHOOL_YEAR_START_AGE && !atDaycare.has(child.id);
  });
}

/** The family's mail was read and settled within {@link MAIL_REREAD_MS}. */
async function mailReadRecently(database: Database, familyId: string, now: Date) {
  const t = schema.familySweepMarks;
  const [row] = await database
    .select({ sweptAt: t.sweptAt })
    .from(t)
    .where(
      and(
        eq(t.familyId, familyId),
        eq(t.sweep, SCHOOL_BREAK_MAIL_SWEEP),
        gt(t.sweptAt, new Date(now.getTime() - MAIL_REREAD_MS)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function mark(database: Database, familyId: string, sweep: string, now: Date) {
  const t = schema.familySweepMarks;
  await database
    .insert(t)
    .values({ familyId, sweep, sweptAt: now })
    .onConflictDoUpdate({ target: [t.familyId, t.sweep], set: { sweptAt: now } });
}

/** The ask went to this family this school year, in any status. */
async function askedThisYear(
  database: Database,
  familyId: string,
  schoolYear: string,
): Promise<boolean> {
  const t = schema.proactiveCandidates;
  const [row] = await database
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.familyId, familyId),
        eq(t.kind, SCHOOL_BREAK_ASK_KIND),
        eq(t.why, askWhy(schoolYear)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function askWhy(schoolYear: string): string {
  return `${SCHOOL_BREAK_ASK_KIND} year=${schoolYear}`;
}

function sameBreak(
  fact: SchoolBreakFact | null,
  source: SchoolBreakFact['source'],
  reading: VerifiedBreakReading,
  sourceUrl: string | null,
) {
  return (
    fact !== null &&
    fact.source === source &&
    fact.firstDay === reading.firstDay.date &&
    fact.lastDay === reading.lastDay.date &&
    fact.sourceUrl === sourceUrl
  );
}

function daysOf(reading: VerifiedBreakReading): string {
  return `${reading.firstDay.date}/${reading.lastDay.date}`;
}

function faultOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

async function refreshBoard(
  database: Database,
  lookup: BoardLookupDeps,
  host: string,
  schoolYear: string,
  prior: StoredBoardReading | null,
  now: Date,
  result: SchoolBreakSweepResult,
): Promise<StoredBoardReading | null> {
  result.lookedUp += 1;
  const found = await lookupBoardBreak(lookup, host, schoolYear);
  if (found.status === 'retry') {
    // A stale reading still stands while its page is read again. With none, the tries
    // are bounded: the families waiting on this host are asked instead.
    const tries = 1 + (await unfinishedLookups(database, host, schoolYear, prior?.readAt ?? null));
    if (prior !== null || tries < MAX_LOOKUP_TRIES) {
      await recordUnfinishedLookup(database, host, schoolYear, found.reason, now);
      result.retry += 1;
      console.info({ reason: found.reason, tries }, 'school break: lookup did not finish');
      return prior;
    }
    await recordBoardReading(
      database,
      host,
      schoolYear,
      { status: 'not_found', reason: 'lookup_unfinished', boardName: null },
      now,
    );
    result.retriesExhausted += 1;
    console.info({ reason: found.reason, tries }, 'school break: lookup tries ran out');
    return latestBoardReading(database, host, schoolYear);
  }
  await recordBoardReading(database, host, schoolYear, found, now);
  if (found.status === 'verified') result.verified += 1;
  else {
    result.notFound += 1;
    console.info(
      { reason: found.reason, tried: found.tried.map((page) => page.outcome) },
      'school break: no verified winter break on the school page',
    );
  }
  return latestBoardReading(database, host, schoolYear);
}

interface FamilyWork {
  familyId: string;
  hosts: string[];
  messages: SchoolMessage[];
  mailRead: boolean;
}

export async function runSchoolBreakSweep(
  database: Database,
  deps: SchoolBreakSweepDeps,
  now: Date = new Date(),
): Promise<SchoolBreakSweepResult> {
  if (!schoolBreakEnabled()) {
    console.info({ env: 'SCHOOL_BREAK_ENABLED' }, 'school break: switched off, nothing read');
    return emptyResult('flag_off');
  }
  const result = emptyResult(null);
  const schoolYear = schoolYearOf(dayKeyOf(now, DEFAULT_TIMEZONE));

  const byHost = new Map<string, string[]>();
  const families: FamilyWork[] = [];
  let mailReadsLeft = MAX_MAIL_READS_PER_RUN;
  for (const familyId of await loadFamilies(database)) {
    result.families += 1;
    if (!deps.f14For(familyId)) {
      result.f14Dark += 1;
      continue;
    }
    if (!(await hasSchoolAgeChild(database, familyId, schoolYear))) {
      result.noSchoolChild += 1;
      continue;
    }
    const fact = await loadSchoolBreak(database, familyId, schoolYear);
    if (fact?.source === 'parent') {
      result.parentKnown += 1;
      continue;
    }
    if (fact === null && (await askedThisYear(database, familyId, schoolYear))) {
      result.asked += 1;
      continue;
    }
    // A page break on file keeps its own host read when its reading is due, and the mail
    // is still read daily beside it: a school seen later is weighed against it.
    const onFile = fact?.source === 'board_page' && fact.boardHost ? [fact.boardHost] : [];
    let messages: SchoolMessage[] = [];
    let mailRead = false;
    if (!(await mailReadRecently(database, familyId, now))) {
      if (mailReadsLeft === 0) {
        if (fact === null) {
          result.deferred += 1;
          continue;
        }
      } else {
        mailReadsLeft -= 1;
        try {
          await mark(database, familyId, SCHOOL_BREAK_MAIL_SERVED_SWEEP, now);
          const mail = await deps.schoolMail.schoolMail(familyId);
          mailRead = true;
          if (mail.status === 'read') {
            result.mailRead += 1;
            result.unaligned += mail.unaligned;
            messages = mail.messages;
          } else if (mail.status === 'unread') {
            result.mailRead += 1;
            result.mailUnread += 1;
            console.info({ reason: mail.reason }, 'school break: school mail not read');
          }
        } catch (err) {
          result.failed += 1;
          console.error({ fault: faultOf(err) }, 'school break: school mail failed');
          continue;
        }
      }
    }
    const hosts = [...new Set([...onFile, ...messages.map((m) => m.host)])].sort();
    for (const host of hosts) byHost.set(host, [...(byHost.get(host) ?? []), familyId]);
    families.push({ familyId, hosts, messages, mailRead });
  }

  // Busiest schools first, so a bounded run reaches the most families.
  const readings = new Map<string, StoredBoardReading | null>();
  let lookupsLeft = MAX_BOARD_LOOKUPS_PER_RUN;
  const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [host] of hosts) {
    // One school failing is that school's outcome, never the others'.
    try {
      let reading = await latestBoardReading(database, host, schoolYear);
      const due = reading === null || reading.reverifyAt.getTime() <= now.getTime();
      if (due && deps.lookup === null) result.noClient += 1;
      else if (due && lookupsLeft === 0) result.deferred += 1;
      else if (due && deps.lookup !== null) {
        lookupsLeft -= 1;
        reading = await refreshBoard(database, deps.lookup, host, schoolYear, reading, now, result);
      }
      readings.set(host, reading);
    } catch (err) {
      result.failed += 1;
      readings.set(host, null);
      console.error({ fault: faultOf(err) }, 'school break: board failed');
    }
  }

  const gate = deps.buildGate(database);
  for (const work of families) {
    try {
      const settled = await settleFamily(
        database,
        deps,
        gate,
        work,
        schoolYear,
        readings,
        now,
        result,
      );
      // Mail that named a school still being read is read again next hour.
      if (work.mailRead && settled !== 'waiting') {
        await mark(database, work.familyId, SCHOOL_BREAK_MAIL_SWEEP, now);
      }
    } catch (err) {
      result.failed += 1;
      console.error({ fault: faultOf(err) }, 'school break: family failed');
    }
  }
  if (result.recorded > 0 || result.queued > 0) {
    console.info(
      { recorded: result.recorded, queued: result.queued },
      'school break: breaks recorded and asks queued for the decider',
    );
  }
  return result;
}

async function settleFamily(
  database: Database,
  deps: SchoolBreakSweepDeps,
  gate: OutboundGatePorts,
  work: FamilyWork,
  schoolYear: string,
  readings: Map<string, StoredBoardReading | null>,
  now: Date,
  result: SchoolBreakSweepResult,
): Promise<'settled' | 'waiting'> {
  const { familyId } = work;
  // A school still waiting on its first reading may yet answer, or disagree: nothing is
  // filed or asked before it does.
  if (work.hosts.some((host) => (readings.get(host) ?? null) === null)) {
    result.waiting += 1;
    return 'waiting';
  }
  const verified = work.hosts.flatMap((host) => {
    const reading = readings.get(host) ?? null;
    return reading?.status === 'verified' ? [{ host, reading }] : [];
  });
  // Two schools with different days: Hale cannot tell which one is this family's kid's,
  // so it files neither and asks.
  if (new Set(verified.map(({ reading }) => daysOf(reading))).size > 1) {
    result.disagreed += 1;
    await askOnce(database, deps, gate, familyId, schoolYear, now, result);
    return 'settled';
  }
  const fact = await loadSchoolBreak(database, familyId, schoolYear);
  const board = verified[0];
  if (board) {
    if (sameBreak(fact, 'board_page', board.reading, board.reading.sourceUrl)) return 'settled';
    await recordSchoolBreak(database, {
      source: 'board_page',
      familyId,
      schoolYear,
      name: board.reading.name,
      firstDay: board.reading.firstDay,
      lastDay: board.reading.lastDay,
      sourceUrl: board.reading.sourceUrl,
      boardHost: board.host,
      now,
    });
    result.recorded += 1;
    return 'settled';
  }
  if (fact) return 'settled';
  if (work.messages.length > 0) {
    if (deps.lookup === null) {
      result.noClient += 1;
      result.waiting += 1;
      return 'waiting';
    }
    const emailed = await readSchoolEmails(deps, deps.lookup, work, schoolYear, result);
    if (new Set(emailed.map(({ reading }) => daysOf(reading))).size > 1) {
      result.disagreed += 1;
      await askOnce(database, deps, gate, familyId, schoolYear, now, result);
      return 'settled';
    }
    const email = emailed[0];
    if (email) {
      await recordSchoolBreak(database, {
        source: 'school_email',
        familyId,
        schoolYear,
        name: email.reading.name,
        firstDay: email.reading.firstDay,
        lastDay: email.reading.lastDay,
        boardHost: email.host,
        now,
      });
      result.recorded += 1;
      return 'settled';
    }
  }
  await askOnce(database, deps, gate, familyId, schoolYear, now, result);
  return 'settled';
}

/** The breaks the family's newest school emails state, each read off its own text. */
async function readSchoolEmails(
  deps: SchoolBreakSweepDeps,
  lookup: BoardLookupDeps,
  work: FamilyWork,
  schoolYear: string,
  result: SchoolBreakSweepResult,
): Promise<Array<{ host: string; reading: VerifiedBreakReading }>> {
  const found: Array<{ host: string; reading: VerifiedBreakReading }> = [];
  for (const message of work.messages.slice(0, MAX_EMAIL_TEXTS_PER_FAMILY)) {
    const text = await deps.schoolMail.text(work.familyId, message);
    if (text.status === 'unread') {
      console.info({ reason: text.reason }, 'school break: school email text not read');
      continue;
    }
    result.emailRead += 1;
    const reading = await lookup.readText({ text: text.text, schoolYear });
    if (reading.status === 'verified') {
      found.push({ host: message.host, reading });
    } else {
      console.info(
        { outcome: 'reason' in reading ? `${reading.status}:${reading.reason}` : reading.status },
        'school break: no verified winter break in the school email',
      );
    }
  }
  return found;
}

async function askOnce(
  database: Database,
  deps: SchoolBreakSweepDeps,
  gate: OutboundGatePorts,
  familyId: string,
  schoolYear: string,
  now: Date,
  result: SchoolBreakSweepResult,
): Promise<void> {
  if (await askedThisYear(database, familyId, schoolYear)) {
    result.asked += 1;
    return;
  }
  const lastDay = lastAskDay(schoolYear);
  if (dayKeyOf(now, DEFAULT_TIMEZONE) > lastDay) {
    result.tooLate += 1;
    return;
  }
  // One parent, once: the household's first textable seat, primary before co-parent.
  const [recipient] = (await deps.recipients(database, familyId)).sort((a, b) =>
    a.role === b.role ? 0 : a.role === 'primary_parent' ? -1 : 1,
  );
  if (!recipient) {
    result.held += 1;
    return;
  }
  const verdict = await assertProactiveSendAllowed(
    { familyId, parentUserId: recipient.parentUserId, kind: SCHOOL_BREAK_ASK_KIND, now },
    gate,
  );
  if (!verdict.allowed) {
    result.held += 1;
    return;
  }
  const queued = await deps.queueCandidate(database, {
    familyId,
    parentUserId: recipient.parentUserId,
    kind: SCHOOL_BREAK_ASK_KIND,
    category: 'nudge',
    templateKey: SCHOOL_BREAK_ASK_TEMPLATE_KEY,
    // Item data, like every decider lane's `what`; the writer skill says how to ask.
    what: `winter break ${schoolYear}`,
    why: askWhy(schoolYear),
    sourceUrl: null,
    worthlessAfter: zonedLocalInstant(lastDay, '12:00', recipient.timeZone),
    parentRequested: false,
    dedupeKey: schoolBreakAskDedupeKey(familyId, schoolYear, recipient.parentUserId),
  });
  if (queued === 'duplicate') {
    result.asked += 1;
    return;
  }
  result.queued += 1;
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'proactive_cadence_queued',
    targetTable: 'families',
    targetId: familyId,
    after: { kind: SCHOOL_BREAK_ASK_KIND, schoolYear },
  });
}
