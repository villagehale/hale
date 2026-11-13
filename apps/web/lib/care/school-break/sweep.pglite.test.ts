import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWeekdayCareContext } from '~/lib/care/weekday';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { SCHOOL_BREAK_ASK_TEMPLATE_KEY, parseWeekdayAskKey } from '~/lib/channel/weekday-care/key';
import { CONNECTOR_SCOPES } from '~/lib/integrations/google-oauth';
import type { GoogleFetch } from '~/lib/integrations/sync';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { SCHOOL_BREAK_FACT_KEY, loadSchoolBreak, recordSchoolBreak } from './facts';
import { SCHOOL_BREAK_ENABLED_ENV } from './flag';
import type { BoardLookupDeps } from './lookup';
import type { BreakPageReading } from './read';
import { productionSchoolMailPorts, schoolMailReader } from './school-mail';
import type { CalendarSearch } from './search';
import {
  SCHOOL_BREAK_ASK_KIND,
  type SchoolBreakSweepDeps,
  defaultSchoolBreakSweepDeps,
  runSchoolBreakSweep,
} from './sweep';

/**
 * The winter-break sweep against real Postgres: the per-board cache, the family fact,
 * the decider queue and the audit rows are the real ones, and so is the weekday context
 * the break question reads. The search and the page reader are scripted ports (their
 * model work is the school-break eval's, hard rule #8); the gate's consent reads are a
 * port (outbound-gate.test.ts owns them).
 */

/** Thursday Nov 12, 10:00 in Ontario. */
const NOW = new Date('2026-11-12T15:00:00Z');
const BOARD = 'board.example';
const PAGE = 'https://www.board.example/calendar/2026-2027';
const OTHER_BOARD = 'other-board.example';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  inbox.clear();
  gmailReads.length = 0;
  wikidata.queries.length = 0;
  wikidata.fail = false;
  await db.exec('truncate table families, users, school_break_readings cascade');
});

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => 'America/Toronto',
});

const WINTER: BreakPageReading = {
  status: 'verified',
  sourceUrl: PAGE,
  name: 'Winter Break',
  firstDay: { date: '2026-12-21', quote: 'Winter Break: December 21, 2026 to January 1, 2027' },
  lastDay: { date: '2027-01-01', quote: 'Winter Break: December 21, 2026 to January 1, 2027' },
};

function scripted(
  over: { search?: (host: string) => CalendarSearch; read?: () => BreakPageReading } = {},
) {
  const searches: string[] = [];
  const reads: string[] = [];
  const lookup: BoardLookupDeps = {
    search: async (host) => {
      searches.push(host);
      return over.search
        ? over.search(host)
        : { outcome: 'pages', boardName: 'Example District School Board', urls: [PAGE] };
    },
    read: async ({ url }) => {
      reads.push(url);
      return over.read ? over.read() : WINTER;
    },
  };
  return { lookup, searches, reads };
}

/** The mailbox, faked at Google's edge: message id to its From header. */
const inbox = new Map<string, string>();
const gmailReads: string[] = [];
const fakeGmail: GoogleFetch = async (url) => {
  const id = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  gmailReads.push(id);
  const from = inbox.get(id);
  if (from === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return {
    ok: true,
    status: 200,
    json: async () => ({ payload: { headers: [{ name: 'From', value: from }] } }),
  };
};

/** Wikidata, faked at its port: these hosts are the official sites of school boards. */
const PROVEN_BOARDS: Record<string, string> = { [BOARD]: 'Q101', [OTHER_BOARD]: 'Q102' };
const wikidata = {
  queries: [] as string[],
  fail: false,
  async sparql(query: string): Promise<unknown> {
    this.queries.push(query);
    if (this.fail) throw new Error('source down');
    return {
      results: {
        bindings: Object.entries(PROVEN_BOARDS)
          .filter(([host]) => query.includes(`<https://www.${host}/>`))
          .map(([host, qid]) => ({
            item: { value: `http://www.wikidata.org/entity/${qid}` },
            site: { value: `https://www.${host}/` },
          })),
      },
    };
  },
};

function deps(
  lookup: BoardLookupDeps | null,
  over: Partial<SchoolBreakSweepDeps> = {},
): SchoolBreakSweepDeps {
  return {
    ...defaultSchoolBreakSweepDeps(db.database, null),
    lookup,
    schoolMail: schoolMailReader({
      ...productionSchoolMailPorts(db.database, fakeGmail),
      accessToken: async () => 'test-token',
    }),
    boardSite: wikidata,
    buildGate: openGate,
    queueCandidate: queueCheckInForDecider,
    f14For: () => true,
    recipients: async (database, familyId) =>
      (
        await database
          .select({ parentUserId: schema.familyMembers.userId, role: schema.familyMembers.role })
          .from(schema.familyMembers)
          .where(eq(schema.familyMembers.familyId, familyId))
      ).map((row) => ({
        parentUserId: row.parentUserId,
        timeZone: 'America/Toronto',
        role: row.role as 'primary_parent' | 'co_parent',
      })),
    ...over,
  };
}

let seq = 0;

async function seedFamily(
  input: {
    senders?: string[];
    dateOfBirth?: string;
    parents?: number;
    gmailStatus?: 'active' | 'revoked';
  } = {},
): Promise<{ familyId: string; parentIds: string[] }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Test household' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const parentIds: string[] = [];
  for (let i = 0; i < (input.parents ?? 1); i++) {
    const [user] = await db.database
      .insert(schema.users)
      .values({ name: `Parent ${i}`, timezone: 'America/Toronto' })
      .returning({ id: schema.users.id });
    parentIds.push(user?.id as string);
    await db.database.insert(schema.familyMembers).values({
      familyId,
      userId: user?.id as string,
      role: i === 0 ? 'primary_parent' : 'co_parent',
    });
  }
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Robin', dateOfBirth: input.dateOfBirth ?? '2019-03-01' });
  if ((input.senders ?? []).length > 0) {
    const [gmail] = await db.database
      .insert(schema.integrations)
      .values({
        familyId,
        userId: parentIds[0] as string,
        provider: 'gmail',
        status: input.gmailStatus ?? 'active',
        scopes: [...CONNECTOR_SCOPES.gmail],
        oauthTokensEncrypted: null,
      })
      .returning({ id: schema.integrations.id });
    for (const senderDomain of input.senders ?? []) {
      seq += 1;
      const messageId = `msg-${seq}`;
      inbox.set(messageId, `School Office <office@${senderDomain}>`);
      const [message] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId,
          parentUserId: parentIds[0] as string,
          channel: 'sms',
          direction: 'out',
          category: 'alert',
          status: 'sent',
          sentAt: NOW,
        })
        .returning({ id: schema.channelMessages.id });
      await db.database.insert(schema.emailAlertOffers).values({
        familyId,
        parentUserId: parentIds[0] as string,
        integrationId: gmail?.id as string,
        messageId,
        kind: 'new_event',
        title: 'Curriculum night',
        startsAt: NOW,
        channelMessageId: message?.id as string,
        expiresAt: NOW,
      });
    }
  }
  return { familyId, parentIds };
}

/** One more email alert for a family already seeded with Gmail, from `senderDomain`. */
async function alertFrom(familyId: string, senderDomain: string) {
  const [gmail] = await db.database
    .select({ id: schema.integrations.id, userId: schema.integrations.userId })
    .from(schema.integrations)
    .where(eq(schema.integrations.familyId, familyId));
  seq += 1;
  const messageId = `msg-${seq}`;
  inbox.set(messageId, `School Office <office@${senderDomain}>`);
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId: gmail?.userId as string,
      channel: 'sms',
      direction: 'out',
      category: 'alert',
      status: 'sent',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.emailAlertOffers).values({
    familyId,
    parentUserId: gmail?.userId as string,
    integrationId: gmail?.id as string,
    messageId,
    kind: 'new_event',
    title: 'Curriculum night',
    startsAt: NOW,
    channelMessageId: message?.id as string,
    expiresAt: NOW,
  });
  return messageId;
}

const OTHER_PAGE = 'https://www.other-board.example/calendar';
const EARLIER: BreakPageReading = {
  status: 'verified',
  sourceUrl: OTHER_PAGE,
  name: 'Winter Break',
  firstDay: { date: '2026-12-19', quote: 'Winter break: December 19 to January 3' },
  lastDay: { date: '2027-01-03', quote: 'Winter break: December 19 to January 3' },
};

/** Each board's own page: BOARD's says WINTER, OTHER_BOARD's says `other`. */
function twoBoards(other: BreakPageReading): BoardLookupDeps {
  return {
    search: async (host) => ({
      outcome: 'pages',
      boardName: 'Example District School Board',
      urls: [host === BOARD ? PAGE : OTHER_PAGE],
    }),
    read: async ({ url }) => (url === PAGE ? WINTER : other),
  };
}

async function asks(familyId: string) {
  return db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, familyId),
        eq(schema.proactiveCandidates.kind, SCHOOL_BREAK_ASK_KIND),
      ),
    );
}

async function audits(familyId: string, actionTaken: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, actionTaken)),
    );
}

describe('the winter-break sweep', () => {
  it('reads nothing while the kill switch is off', async () => {
    vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, 'false');
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const script = scripted();
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result.skipped).toBe('flag_off');
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toEqual([]);
  });

  it("reads the board once for every family on its host and files each family's break with its source", async () => {
    const one = await seedFamily({ senders: [BOARD] });
    const two = await seedFamily({ senders: [BOARD] });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches).toEqual([BOARD]);
    expect(result).toMatchObject({ lookedUp: 1, verified: 1, recorded: 2, queued: 0 });
    const [reading] = await db.database.select().from(schema.schoolBreakReadings);
    expect(reading).toMatchObject({
      boardHost: BOARD,
      schoolYear: '2026-27',
      status: 'verified',
      sourceUrl: PAGE,
    });
    for (const { familyId } of [one, two]) {
      expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
        source: 'board_page',
        firstDay: '2026-12-21',
        lastDay: '2027-01-01',
        sourceUrl: PAGE,
        boardHost: BOARD,
        quotes: ['Winter Break: December 21, 2026 to January 1, 2027'],
      });
      expect(await audits(familyId, 'school_break_recorded')).toHaveLength(1);
      expect(await asks(familyId)).toEqual([]);
    }

    // The next hour: the cache is fresh and the facts already say it.
    const again = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(script.searches).toEqual([BOARD]);
    expect(again).toMatchObject({ lookedUp: 0, recorded: 0 });
    expect(await audits(one.familyId, 'school_break_recorded')).toHaveLength(1);
  });

  it('hands the break question the board break, through the production context', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);

    const context = await loadWeekdayCareContext(db.database, familyId, NOW);
    expect(context.verifiedBreak).toEqual({
      eventKey: 'winter-break-2026-12-21',
      label: 'Winter Break',
      date: '2026-12-21',
      source: 'school_calendar',
    });
  });

  it('reads two boards separately, and never takes one board for another', async () => {
    const { familyId } = await seedFamily({ senders: [OTHER_BOARD] });
    const script = scripted({
      search: (host) =>
        host === OTHER_BOARD
          ? { outcome: 'none', reason: 'no_calendar_page' }
          : { outcome: 'pages', boardName: 'Example District School Board', urls: [PAGE] },
    });
    await seedFamily({ senders: [BOARD] });

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect([...script.searches].sort()).toEqual([BOARD, OTHER_BOARD]);
    expect(result).toMatchObject({ verified: 1, notFound: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    // No page for their board: the one question instead of the other board's dates.
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('asks once, per family, when no page has the days, and never again this school year', async () => {
    const { familyId, parentIds } = await seedFamily({ parents: 2 });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches).toEqual([]);
    expect(result).toMatchObject({ queued: 1 });
    const [ask, ...more] = await asks(familyId);
    expect(more).toEqual([]);
    expect(ask).toMatchObject({
      parentUserId: parentIds[0],
      category: 'nudge',
      templateKey: SCHOOL_BREAK_ASK_TEMPLATE_KEY,
      sourceUrl: null,
      status: 'queued',
    });
    expect(parseWeekdayAskKey(ask?.dedupeKey ?? null)).toEqual({
      scope: 'break_dates',
      schoolYear: '2026-27',
    });
    expect(ask?.worthlessAfter?.toISOString()).toBe('2026-12-15T17:00:00.000Z');
    expect(await audits(familyId, 'proactive_cadence_queued')).toHaveLength(1);

    const again = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(again).toMatchObject({ queued: 0, asked: 1 });
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('does not ask while a board lookup has not finished', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const script = scripted({ search: () => ({ outcome: 'failed', reason: 'search_failed:x' }) });
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result).toMatchObject({ retry: 1, waiting: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
    expect(await db.database.select().from(schema.schoolBreakReadings)).toEqual([]);
  });

  it("leaves a parent's own answer alone: no lookup, no question, no board write over it", async () => {
    const { familyId, parentIds } = await seedFamily({ senders: [BOARD] });
    await recordSchoolBreak(db.database, {
      source: 'parent',
      familyId,
      parentUserId: parentIds[0] as string,
      schoolYear: '2026-27',
      name: 'winter break',
      firstDay: '2026-12-18',
      lastDay: '2027-01-04',
      quote: 'dec 18 to jan 4',
      now: NOW,
    });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(result).toMatchObject({ parentKnown: 1, lookedUp: 0, recorded: 0, queued: 0 });
    expect(script.searches).toEqual([]);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      source: 'parent',
      firstDay: '2026-12-18',
    });
    const context = await loadWeekdayCareContext(db.database, familyId, NOW);
    expect(context.verifiedBreak).toEqual({
      eventKey: 'winter-break-2026-12-18',
      label: 'winter break',
      date: '2026-12-18',
      source: 'parent_said',
    });
  });

  it('skips a family with no child in school or daycare', async () => {
    const { familyId } = await seedFamily({ dateOfBirth: '2024-06-01' });
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(result).toMatchObject({ noSchoolChild: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('asks nothing once the winter break is too close to plan around', async () => {
    const { familyId } = await seedFamily();
    const late = new Date('2026-12-16T15:00:00Z');
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), late);
    expect(result).toMatchObject({ tooLate: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('counts a missing model client by name and asks nothing for a board it could not read', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const result = await runSchoolBreakSweep(db.database, deps(null), NOW);
    expect(result).toMatchObject({ noClient: 1, waiting: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('the fact is writer-pinned: a row under the key from another writer is not a break', async () => {
    const { familyId } = await seedFamily();
    await db.database.insert(schema.familyMemoryFacts).values({
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: SCHOOL_BREAK_FACT_KEY,
      factValue: {
        schoolYear: '2026-27',
        name: 'Winter Break',
        firstDay: '2026-12-21',
        lastDay: '2027-01-01',
        source: 'board_page',
        sourceUrl: PAGE,
        boardHost: BOARD,
        quotes: ['x'],
      },
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toBeNull();
  });
  it('reads the board off the school mail Hale already alerted on: the sender proven a board by Wikidata', async () => {
    const { familyId } = await seedFamily({ senders: [`mail.${BOARD}`] });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(gmailReads).toEqual([`msg-${seq}`]);
    expect(wikidata.queries).toHaveLength(1);
    expect(script.searches).toEqual([BOARD]);
    expect(result).toMatchObject({ verified: 1, recorded: 1, queued: 0 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      source: 'board_page',
      boardHost: BOARD,
      sourceUrl: PAGE,
    });
  });

  it('never searches a sender Wikidata does not prove a school: the family is asked once instead', async () => {
    const { familyId } = await seedFamily({ senders: ['club.example'] });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(wikidata.queries).toHaveLength(1);
    expect(script.searches).toEqual([]);
    expect(await db.database.select().from(schema.schoolBreakReadings)).toEqual([]);
    expect(result).toMatchObject({ queued: 1 });
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('reads no mail from a connection that is no longer active', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD], gmailStatus: 'revoked' });
    const script = scripted();
    await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(gmailReads).toEqual([]);
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toHaveLength(1);
  });

  it("reads no mail the parent or the kid check called the parent's own", async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const [offer] = await db.database
      .select({
        integrationId: schema.emailAlertOffers.integrationId,
        messageId: schema.emailAlertOffers.messageId,
      })
      .from(schema.emailAlertOffers)
      .where(eq(schema.emailAlertOffers.familyId, familyId));
    await db.database.insert(schema.kidRelevanceVerdicts).values({
      familyId,
      source: 'gmail',
      integrationId: offer?.integrationId as string,
      itemKey: offer?.messageId as string,
      inputHash: 'parent',
      verdict: 'adult',
      decidedBy: 'parent',
    });
    const script = scripted();
    await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(gmailReads).toEqual([]);
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toHaveLength(1);
  });

  it("lists only the family's own alerts, and reads only its own active connection that holds the read scope", async () => {
    const one = await seedFamily({ senders: [BOARD] });
    const two = await seedFamily({ senders: [OTHER_BOARD] });
    const ports = productionSchoolMailPorts(db.database, fakeGmail);
    const mine = await ports.alertedMail(one.familyId);
    expect(mine).toHaveLength(1);
    const [theirs] = await ports.alertedMail(two.familyId);
    expect(theirs?.integrationId).not.toBe(mine[0]?.integrationId);

    const integrationId = mine[0]?.integrationId as string;
    expect(await ports.readable(one.familyId, integrationId)).toBe(true);
    expect(await ports.readable(two.familyId, integrationId)).toBe(false);
    await db.database
      .update(schema.integrations)
      .set({ scopes: ['openid'] })
      .where(eq(schema.integrations.id, integrationId));
    expect(await ports.readable(one.familyId, integrationId)).toBe(false);
  });

  it('asks rather than waits when the mail cannot be read, and names it', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    const failing: GoogleFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await runSchoolBreakSweep(
      db.database,
      deps(scripted().lookup, {
        schoolMail: schoolMailReader({
          ...productionSchoolMailPorts(db.database, failing),
          accessToken: async () => 'test-token',
        }),
      }),
      NOW,
    );
    expect(result).toMatchObject({ mailUnread: 1, queued: 1 });
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('waits, and asks nothing, while Wikidata does not answer', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    wikidata.fail = true;
    const script = scripted();
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result).toMatchObject({ waiting: 1, queued: 0 });
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toEqual([]);

    // Back the next hour: the mail is read again, because nothing settled.
    wikidata.fail = false;
    const again = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(script.searches).toEqual([BOARD]);
    expect(again).toMatchObject({ recorded: 1 });
  });

  it("reads a family's mail at most once a day once it settled", async () => {
    const { familyId } = await seedFamily({ senders: ['club.example'] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(gmailReads).toHaveLength(1);
    // With the family still open (its ask cleared here), its mail is not read again that day.
    await db.database
      .delete(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, familyId));
    const later = new Date(NOW.getTime() + 60 * 60_000);
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), later);
    expect(gmailReads).toHaveLength(1);
    await db.database
      .delete(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, familyId));
    const nextDay = new Date(NOW.getTime() + 25 * 60 * 60_000);
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), nextDay);
    expect(gmailReads).toHaveLength(2);
  });

  it('files no break and asks the parent once when two proven schools disagree on the days', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD, OTHER_BOARD] });
    const result = await runSchoolBreakSweep(db.database, deps(twoBoards(EARLIER)), NOW);
    expect(result).toMatchObject({ verified: 2, recorded: 0, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('files the break when two proven schools give the same days', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD, OTHER_BOARD] });
    const same: BreakPageReading = { ...WINTER, sourceUrl: OTHER_PAGE };
    const result = await runSchoolBreakSweep(db.database, deps(twoBoards(same)), NOW);
    expect(result).toMatchObject({ verified: 2, recorded: 1, queued: 0 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      firstDay: '2026-12-21',
      lastDay: '2027-01-01',
      boardHost: BOARD,
    });
  });

  it('reads the mail again the next day with a board break on file, and asks when a second proven school disagrees', async () => {
    const { familyId, parentIds } = await seedFamily({ senders: [BOARD], parents: 2 });
    await runSchoolBreakSweep(db.database, deps(twoBoards(EARLIER)), NOW);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
    });
    expect(gmailReads).toHaveLength(1);

    await alertFrom(familyId, OTHER_BOARD);
    const nextDay = new Date(NOW.getTime() + 25 * 60 * 60_000);
    const result = await runSchoolBreakSweep(db.database, deps(twoBoards(EARLIER)), nextDay);

    expect(gmailReads).toHaveLength(3);
    expect(result).toMatchObject({ disagreed: 1, recorded: 0, queued: 1 });
    expect(await asks(familyId)).toHaveLength(1);

    // Still disagreeing a day later, with another parent first: still one ask this year.
    const dayAfter = new Date(NOW.getTime() + 50 * 60 * 60_000);
    const onlySecond = deps(twoBoards(EARLIER), {
      recipients: async () => [
        { parentUserId: parentIds[1] as string, timeZone: 'America/Toronto', role: 'co_parent' },
      ],
    });
    const again = await runSchoolBreakSweep(db.database, onlySecond, dayAfter);
    expect(again).toMatchObject({ disagreed: 1, asked: 1, queued: 0 });
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('reads no more mail in a run once Wikidata has not answered, and asks Wikidata once', async () => {
    for (let i = 0; i < 7; i++) await seedFamily({ senders: [BOARD] });
    wikidata.fail = true;
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(wikidata.queries).toHaveLength(1);
    expect(gmailReads).toHaveLength(1);
    expect(result).toMatchObject({ mailRead: 1, waiting: 1, deferred: 6, queued: 0 });
  });

  it('counts a child in junior kindergarten from the school year they turn four', async () => {
    const jk = await seedFamily({ dateOfBirth: '2022-11-15' });
    const notYet = await seedFamily({ dateOfBirth: '2023-01-10' });
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(result).toMatchObject({ noSchoolChild: 1, queued: 1 });
    expect(await asks(jk.familyId)).toHaveLength(1);
    expect(await asks(notYet.familyId)).toEqual([]);
  });

  it("asks once a school year even when the household's first parent changes", async () => {
    const { familyId, parentIds } = await seedFamily({ parents: 2 });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    const onlySecond = deps(scripted().lookup, {
      recipients: async () => [
        { parentUserId: parentIds[1] as string, timeZone: 'America/Toronto', role: 'co_parent' },
      ],
    });
    const again = await runSchoolBreakSweep(db.database, onlySecond, NOW);
    expect(again).toMatchObject({ asked: 1, queued: 0 });
    expect((await asks(familyId)).map((row) => row.parentUserId)).toEqual([parentIds[0]]);
  });

  it('queues no ask the outbound gate refuses', async () => {
    const { familyId } = await seedFamily();
    const closed = (): OutboundGatePorts => ({ ...openGate(), channelEnrolled: async () => false });
    const result = await runSchoolBreakSweep(
      db.database,
      deps(scripted().lookup, { buildGate: closed }),
      NOW,
    );
    expect(result).toMatchObject({ held: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('names no break to the break question while the kill switch is off, though the fact stands', async () => {
    const { familyId } = await seedFamily({ senders: [BOARD] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).not.toBeNull();
    vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, 'false');
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toBeNull();
  });
});
