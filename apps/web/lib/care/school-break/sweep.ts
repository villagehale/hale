import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { and, eq, gt, inArray } from 'drizzle-orm';
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
  type BoardSite,
  type BoardSiteSource,
  proveBoardSite,
  wikidataBoardSiteSource,
} from './official-board';
import { createLiveBreakPageReader } from './read';
import { type SchoolMailReader, productionSchoolMailPorts, schoolMailReader } from './school-mail';
import { searchSchoolCalendar } from './search';
import { type StoredBoardReading, latestBoardReading, recordBoardReading } from './store';

/**
 * VIL-685 · the hourly winter-break sweep. For every family Hale texts that has a child
 * in school (four or older) or at daycare:
 *
 *   1. A parent's own answer stands, and nothing here touches it.
 *   2. Otherwise, the BOARD: the school mail Hale already alerted this family about names
 *      the domains it came from (school-mail.ts); a domain Wikidata proves is a school
 *      board's or school's official site names a host (official-board.ts); the board's
 *      calendar on that host is looked up (cached per host, `school_break_readings`) and a
 *      verified break is written to the family's fact with its page and quotes. No host
 *      list, and no two boards assumed alike: a host is read on its own page or not at
 *      all. A family's mail is read at most once a day.
 *   3. Otherwise, ASK ONCE: when no page could give the days, one `school_break_ask`
 *      candidate per family per school year goes to the proactive decider. The decider
 *      decides whether and when, its writer words it, and the outbound gate keeps it in
 *      the parent's daytime. The reply is read in the router (GATE 2c-bis).
 *
 * The break question itself ("winter break is coming, want me to find something?") is
 * the nudge sweep's verified-break rung, which reads the fact this writes.
 */

/** Lookups one run may start: an infra bound on the function's 300 s wall (one lookup is a
 * search turn and up to three page reads). A board left over is looked up next hour. */
export const MAX_BOARD_LOOKUPS_PER_RUN = 3;
/** Families whose mail one run may read (a Gmail read per alert, a Wikidata query per
 * domain): an infra bound on the same wall. A family left over is read next hour. */
export const MAX_MAIL_READS_PER_RUN = 5;
/** A family's mail, once read and settled, is not read again for this long. Freshness of
 * a cache, not a send rule. */
export const MAIL_REREAD_MS = 24 * 60 * 60_000;
export const SCHOOL_BREAK_MAIL_SWEEP = 'school_break_mail';
/** School age: junior kindergarten starts the year a child turns four. */
const SCHOOL_AGE_MONTHS = 48;

export const SCHOOL_BREAK_ASK_KIND = 'school_break_ask' as const;

export interface SchoolBreakSweepResult {
  skipped: 'flag_off' | null;
  families: number;
  f14Dark: number;
  /** No child in school or daycare: there is no break to ask about. */
  noSchoolChild: number;
  /** The parent gave the days; left alone. */
  parentKnown: number;
  /** Families whose school mail was read this run. */
  mailRead: number;
  /** Mail was there and could not be read (token, Google): the family is asked instead. */
  mailUnread: number;
  lookedUp: number;
  verified: number;
  notFound: number;
  retry: number;
  noClient: number;
  deferred: number;
  /** Board facts written or moved to a new reading. */
  recorded: number;
  /** A board host is still waiting on a lookup: no ask yet. */
  waiting: number;
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
    lookedUp: 0,
    verified: 0,
    notFound: 0,
    retry: 0,
    noClient: 0,
    deferred: 0,
    recorded: 0,
    waiting: 0,
    tooLate: 0,
    asked: 0,
    held: 0,
    queued: 0,
    failed: 0,
  };
}

export interface SchoolBreakSweepDeps {
  /** Null when this deploy has no model client: due boards are counted as `noClient`. */
  lookup: BoardLookupDeps | null;
  /** The domains of the school mail Hale already read for a family. */
  schoolMail: SchoolMailReader;
  /** The structured source that proves a domain is a school board's or school's site. */
  boardSite: BoardSiteSource;
  buildGate(database: Database): OutboundGatePorts;
  queueCandidate(database: Database, draft: CandidateDraft): Promise<'queued' | 'duplicate'>;
  f14For(familyId: string): boolean;
  recipients(database: Database, familyId: string): Promise<FamilyTextRecipient[]>;
}

export function boardLookupDeps(client: AgentClient): BoardLookupDeps {
  return {
    search: (officialHost, schoolYear) => searchSchoolCalendar(client, officialHost, schoolYear),
    read: createLiveBreakPageReader(client),
  };
}

export function defaultSchoolBreakSweepDeps(
  database: Database,
  client: AgentClient | null,
): SchoolBreakSweepDeps {
  return {
    lookup: client ? boardLookupDeps(client) : null,
    schoolMail: schoolMailReader(productionSchoolMailPorts(database)),
    boardSite: wikidataBoardSiteSource(),
    buildGate: buildOutboundGatePorts,
    queueCandidate: queueCheckInForDecider,
    f14For: f14EnabledFor,
    recipients: loadFamilyTextRecipients,
  };
}

async function loadFamilies(database: Database): Promise<string[]> {
  const rows = await database
    .selectDistinct({ familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(inArray(schema.familyMembers.role, [...TEXTABLE_ROLES]));
  return rows.map((row) => row.familyId);
}

/** A child four or older, or one the parent said is at daycare. */
async function hasSchoolChild(database: Database, familyId: string, now: Date): Promise<boolean> {
  const children = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  if (children.some((child) => ageInMonths(child.dateOfBirth, now) >= SCHOOL_AGE_MONTHS)) {
    return true;
  }
  return (await loadWeekdayCare(database, familyId)).some((fact) => fact.care === 'daycare');
}

/** The family's mail was read within {@link MAIL_REREAD_MS}. */
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

async function markMailRead(database: Database, familyId: string, now: Date) {
  const t = schema.familySweepMarks;
  await database
    .insert(t)
    .values({ familyId, sweep: SCHOOL_BREAK_MAIL_SWEEP, sweptAt: now })
    .onConflictDoUpdate({ target: [t.familyId, t.sweep], set: { sweptAt: now } });
}

/**
 * The official hosts the family's school mail proves, sorted, or `wait` when the proof
 * source did not answer (nothing is concluded, and nothing is asked, until it does).
 * Mail that cannot be read is named and gives no host: the family is asked instead.
 */
async function hostsFromMail(
  deps: SchoolBreakSweepDeps,
  familyId: string,
  proofs: Map<string, BoardSite>,
  result: SchoolBreakSweepResult,
): Promise<string[] | 'wait'> {
  const mail = await deps.schoolMail.domains(familyId);
  if (mail.status === 'no_mail') return [];
  result.mailRead += 1;
  if (mail.status === 'unread') {
    result.mailUnread += 1;
    console.info({ reason: mail.reason }, 'school break: school mail not read');
    return [];
  }
  const hosts = new Set<string>();
  let wait = false;
  for (const domain of mail.domains) {
    let proof = proofs.get(domain);
    if (proof === undefined) {
      proof = await proveBoardSite(deps.boardSite, domain);
      if (proof.status !== 'retry') proofs.set(domain, proof);
    }
    if (proof.status === 'found') hosts.add(proof.host);
    if (proof.status === 'retry') {
      wait = true;
      console.info({ reason: proof.reason }, 'school break: board site source did not answer');
    }
  }
  if (wait) return 'wait';
  return [...hosts].sort();
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
  reading: StoredBoardReading & { status: 'verified' },
) {
  return (
    fact !== null &&
    fact.source === 'board_page' &&
    fact.firstDay === reading.firstDay.date &&
    fact.lastDay === reading.lastDay.date &&
    fact.sourceUrl === reading.sourceUrl
  );
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
    result.retry += 1;
    console.info({ reason: found.reason }, 'school break: board lookup did not finish');
    return prior;
  }
  await recordBoardReading(database, host, schoolYear, found, now);
  if (found.status === 'verified') result.verified += 1;
  else {
    result.notFound += 1;
    console.info(
      { reason: found.reason, tried: found.tried.map((page) => page.outcome) },
      'school break: no verified winter break on the board page',
    );
  }
  return latestBoardReading(database, host, schoolYear);
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
  const families: Array<{ familyId: string; hosts: string[]; mailRead: boolean }> = [];
  const proofs = new Map<string, BoardSite>();
  let mailReadsLeft = MAX_MAIL_READS_PER_RUN;
  for (const familyId of await loadFamilies(database)) {
    result.families += 1;
    if (!deps.f14For(familyId)) {
      result.f14Dark += 1;
      continue;
    }
    if (!(await hasSchoolChild(database, familyId, now))) {
      result.noSchoolChild += 1;
      continue;
    }
    const fact = await loadSchoolBreak(database, familyId, schoolYear);
    if (fact?.source === 'parent') {
      result.parentKnown += 1;
      continue;
    }
    let hosts: string[];
    let mailRead = false;
    if (fact?.boardHost) {
      // A board break on file: its own host is read again when its reading is due.
      hosts = [fact.boardHost];
    } else if (await askedThisYear(database, familyId, schoolYear)) {
      result.asked += 1;
      continue;
    } else if (await mailReadRecently(database, familyId, now)) {
      hosts = [];
    } else if (mailReadsLeft === 0) {
      result.deferred += 1;
      continue;
    } else {
      try {
        const found = await hostsFromMail(deps, familyId, proofs, result);
        if (found === 'wait') {
          result.waiting += 1;
          continue;
        }
        hosts = found;
        mailRead = true;
        mailReadsLeft -= 1;
      } catch (err) {
        result.failed += 1;
        console.error(
          { fault: err instanceof Error ? err.name : typeof err },
          'school break: school mail failed',
        );
        continue;
      }
    }
    for (const host of hosts) byHost.set(host, [...(byHost.get(host) ?? []), familyId]);
    families.push({ familyId, hosts, mailRead });
  }

  // Busiest boards first, so a bounded run reaches the most families.
  const readings = new Map<string, StoredBoardReading | null>();
  let lookupsLeft = MAX_BOARD_LOOKUPS_PER_RUN;
  const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [host] of hosts) {
    // One board failing is that board's outcome, never the other boards'.
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
      console.error(
        { fault: err instanceof Error ? err.name : typeof err },
        'school break: board failed',
      );
    }
  }

  const gate = deps.buildGate(database);
  for (const { familyId, hosts: familyHosts, mailRead } of families) {
    try {
      const settled = await settleFamily(
        database,
        deps,
        gate,
        { familyId, schoolYear, familyHosts, readings },
        now,
        result,
      );
      // Mail that named a board still being read is read again next hour.
      if (mailRead && settled !== 'waiting') await markMailRead(database, familyId, now);
    } catch (err) {
      result.failed += 1;
      console.error(
        { fault: err instanceof Error ? err.name : typeof err },
        'school break: family failed',
      );
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
  input: {
    familyId: string;
    schoolYear: string;
    familyHosts: string[];
    readings: Map<string, StoredBoardReading | null>;
  },
  now: Date,
  result: SchoolBreakSweepResult,
): Promise<'settled' | 'waiting'> {
  const { familyId, schoolYear, familyHosts, readings } = input;
  const verified = familyHosts
    .map((host) => ({ host, reading: readings.get(host) ?? null }))
    .flatMap(({ host, reading }) => (reading?.status === 'verified' ? [{ host, reading }] : []))
    // Two boards (two kids, two schools): the earlier break is the one to plan for first.
    .sort((a, b) => a.reading.firstDay.date.localeCompare(b.reading.firstDay.date));
  const board = verified[0];
  if (board) {
    const fact = await loadSchoolBreak(database, familyId, schoolYear);
    if (sameBreak(fact, board.reading)) return 'settled';
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
  if (await loadSchoolBreak(database, familyId, schoolYear)) return 'settled';
  // A board still waiting on its first reading may yet answer: no question before it does.
  if (familyHosts.some((host) => (readings.get(host) ?? null) === null)) {
    result.waiting += 1;
    return 'waiting';
  }
  await askOnce(database, deps, gate, { familyId, schoolYear }, now, result);
  return 'settled';
}

async function askOnce(
  database: Database,
  deps: SchoolBreakSweepDeps,
  gate: OutboundGatePorts,
  input: { familyId: string; schoolYear: string },
  now: Date,
  result: SchoolBreakSweepResult,
): Promise<void> {
  const { familyId, schoolYear } = input;
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
    what: "Hale does not know when this family's winter break from school or daycare is this school year. Ask when it starts and ends.",
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
