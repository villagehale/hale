import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWeekdayCareContext, recordWeekdayCare } from '~/lib/care/weekday';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { SCHOOL_BREAK_ASK_TEMPLATE_KEY, parseWeekdayAskKey } from '~/lib/channel/weekday-care/key';
import { CONNECTOR_SCOPES } from '~/lib/integrations/google-oauth';
import type { GoogleFetch } from '~/lib/integrations/sync';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { SCHOOL_BREAK_FACT_KEY, loadSchoolBreak, recordSchoolBreak } from './facts';
import { SCHOOL_BREAK_ENABLED_ENV } from './flag';
import type { BoardLookupDeps } from './lookup';
import { type BreakPageReading, type SchoolBreakExtraction, createTextBreakReader } from './read';
import { productionSchoolMailPorts, schoolMailReader } from './school-mail';
import type { CalendarSearch } from './search';
import { MAX_LOOKUP_TRIES } from './store';
import {
  MAX_MAIL_READS_PER_RUN,
  SCHOOL_BREAK_ASK_KIND,
  type SchoolBreakSweepDeps,
  defaultSchoolBreakSweepDeps,
  runSchoolBreakSweep,
} from './sweep';

/**
 * The winter-break sweep against real Postgres, through the production mail reader:
 * the per-host cache, the family fact, the decider queue and the audit rows are the real
 * ones, and so is the weekday context the break question reads. Only the edges are
 * stipulated: Gmail's answers (headers and bodies, at its fetch), the calendar search and
 * page fetch, and the model's JSON for an email's text, which then goes through the real
 * check (the model's own reading is the school-break eval's, hard rule #8). The gate's
 * consent reads are a port (outbound-gate.test.ts owns them).
 */

/** Thursday Nov 12, 10:00 in Ontario. */
const NOW = new Date('2026-11-12T15:00:00Z');
const BOARD = 'board.example';
const PAGE = 'https://www.board.example/calendar/2026-2027';
const OTHER_BOARD = 'other-board.example';
const OTHER_PAGE = 'https://www.other-board.example/calendar';
const HOUR = 60 * 60_000;

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
  bodyReads.length = 0;
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

const EARLIER: BreakPageReading = {
  status: 'verified',
  sourceUrl: OTHER_PAGE,
  name: 'Winter Break',
  firstDay: { date: '2026-12-19', quote: 'Winter break: December 19 to January 3' },
  lastDay: { date: '2027-01-03', quote: 'Winter break: December 19 to January 3' },
};

/** What the model returns for an email's text: stipulated JSON, checked by real code. */
const NO_BREAK_IN_TEXT: SchoolBreakExtraction = {
  board_on_page: null,
  name: null,
  year_evidence: null,
  first_day: null,
  last_day: null,
  found: false,
};

function scripted(
  over: {
    search?: (host: string) => CalendarSearch;
    read?: (url: string) => BreakPageReading;
    textJson?: (text: string) => SchoolBreakExtraction;
  } = {},
) {
  const searches: string[] = [];
  const reads: string[] = [];
  const texts: string[] = [];
  const lookup: BoardLookupDeps = {
    search: async (host) => {
      searches.push(host);
      return over.search
        ? over.search(host)
        : {
            outcome: 'pages',
            boardName: 'Example District School Board',
            urls: [host === BOARD ? PAGE : `https://www.${host}/calendar`],
          };
    },
    read: async ({ url }) => {
      reads.push(url);
      return over.read ? over.read(url) : url === PAGE ? WINTER : EARLIER;
    },
    readText: createTextBreakReader(async (_schoolYear, text) => {
      texts.push(text);
      return over.textJson ? over.textJson(text) : NO_BREAK_IN_TEXT;
    }),
  };
  return { lookup, searches, reads, texts };
}

/** How Gmail stamped a message: authenticated as its From domain, not, or not at all,
 * with a stamp the sender wrote below Gmail's own. */
type Auth = 'aligned' | 'unaligned' | 'forged_below';

interface FakeMessage {
  from: string;
  auth: Auth;
  body: string;
}

function gmailStamp(domain: string, pass: boolean): string {
  return [
    'mx.google.com',
    `dkim=${pass ? 'pass' : 'pass'} header.i=@${pass ? domain : 'mailer.example'} header.s=s1`,
    `spf=pass (google.com: domain of bounce designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@${pass ? domain : 'mailer.example'}`,
    `dmarc=${pass ? 'pass' : 'fail'} (p=NONE sp=NONE dis=NONE) header.from=${domain}`,
  ].join(';\r\n       ');
}

function headersOf(message: FakeMessage) {
  const domain = message.from.slice(message.from.lastIndexOf('@') + 1).replace(/>$/, '');
  const stamps =
    message.auth === 'aligned'
      ? [gmailStamp(domain, true)]
      : message.auth === 'unaligned'
        ? [gmailStamp(domain, false)]
        : [gmailStamp(domain, false), gmailStamp(domain, true)];
  return [
    ...stamps.map((value) => ({ name: 'Authentication-Results', value })),
    { name: 'From', value: message.from },
  ];
}

/** The mailbox, faked at Google's edge. */
const inbox = new Map<string, FakeMessage>();
const gmailReads: string[] = [];
const bodyReads: string[] = [];
const fakeGmail: GoogleFetch = async (url) => {
  const parsed = new URL(url);
  const id = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
  const message = inbox.get(id);
  if (message === undefined) return { ok: false, status: 404, json: async () => ({}) };
  if (parsed.searchParams.get('format') === 'full') {
    bodyReads.push(id);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        payload: {
          mimeType: 'text/plain',
          body: { data: Buffer.from(message.body).toString('base64url') },
        },
      }),
    };
  }
  gmailReads.push(id);
  return {
    ok: true,
    status: 200,
    json: async () => ({ payload: { headers: headersOf(message) } }),
  };
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

interface Mail {
  domain: string;
  auth?: Auth;
  body?: string;
}

async function seedFamily(
  input: {
    mail?: Array<string | Mail>;
    dateOfBirth?: string;
    parents?: number;
    gmailStatus?: 'active' | 'revoked';
  } = {},
): Promise<{ familyId: string; parentIds: string[]; childId: string }> {
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
  const [child] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Robin', dateOfBirth: input.dateOfBirth ?? '2019-03-01' })
    .returning({ id: schema.children.id });
  if ((input.mail ?? []).length > 0) {
    await db.database.insert(schema.integrations).values({
      familyId,
      userId: parentIds[0] as string,
      provider: 'gmail',
      status: input.gmailStatus ?? 'active',
      scopes: [...CONNECTOR_SCOPES.gmail],
      oauthTokensEncrypted: null,
    });
    for (const mail of input.mail ?? []) await alertFrom(familyId, mail);
  }
  return { familyId, parentIds, childId: child?.id as string };
}

/** One email alert Hale sent this family, about mail from `mail.domain`. */
async function alertFrom(familyId: string, mail: string | Mail) {
  const { domain, auth, body } = typeof mail === 'string' ? { domain: mail } : mail;
  const [gmail] = await db.database
    .select({ id: schema.integrations.id, userId: schema.integrations.userId })
    .from(schema.integrations)
    .where(eq(schema.integrations.familyId, familyId));
  seq += 1;
  const messageId = `msg-${seq}`;
  inbox.set(messageId, {
    from: `School Office <office@${domain}>`,
    auth: auth ?? 'aligned',
    body: body ?? 'Curriculum night is Thursday at 6:30.',
  });
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

async function verdictOn(
  familyId: string,
  messageId: string,
  verdict: 'adult' | 'kid',
  teen = false,
) {
  const [offer] = await db.database
    .select({ integrationId: schema.emailAlertOffers.integrationId })
    .from(schema.emailAlertOffers)
    .where(eq(schema.emailAlertOffers.messageId, messageId));
  await db.database.insert(schema.kidRelevanceVerdicts).values({
    familyId,
    source: 'gmail',
    integrationId: offer?.integrationId as string,
    itemKey: messageId,
    inputHash: 'parent',
    verdict,
    teen,
    decidedBy: verdict === 'adult' ? 'parent' : 'model',
  });
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

async function familyOfMessage(messageId: string) {
  const [row] = await db.database
    .select({ familyId: schema.emailAlertOffers.familyId })
    .from(schema.emailAlertOffers)
    .where(eq(schema.emailAlertOffers.messageId, messageId));
  return row?.familyId;
}

const EMAIL_RANGE = 'Winter Break runs from Monday, December 21, 2026 to Friday, January 1, 2027.';
const EMAIL_BODY = `Dear families,\n\nA reminder that ${EMAIL_RANGE} Classes resume on Monday, January 4, 2027.\n\nThe office`;
const EMAIL_JSON: SchoolBreakExtraction = {
  board_on_page: null,
  name: 'Winter Break',
  year_evidence: null,
  first_day: { quote: EMAIL_RANGE, date_text: 'Monday, December 21, 2026', date: '2026-12-21' },
  last_day: { quote: EMAIL_RANGE, date_text: 'Friday, January 1, 2027', date: '2027-01-01' },
  found: true,
};

describe('the winter-break sweep: which school', () => {
  it('reads the break off the page of the host that authenticated kid mail, and files it with its source', async () => {
    const { familyId } = await seedFamily({ mail: [`mail.${BOARD}`] });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches).toEqual([BOARD]);
    expect(result).toMatchObject({ mailRead: 1, verified: 1, recorded: 1, queued: 0 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      source: 'board_page',
      firstDay: '2026-12-21',
      lastDay: '2027-01-01',
      sourceUrl: PAGE,
      boardHost: BOARD,
      quotes: ['Winter Break: December 21, 2026 to January 1, 2027'],
    });
    expect(await audits(familyId, 'school_break_recorded')).toHaveLength(1);
    const [reading] = await db.database.select().from(schema.schoolBreakReadings);
    expect(reading).toMatchObject({ boardHost: BOARD, status: 'verified', sourceUrl: PAGE });
  });

  it('never takes a From domain the message did not authenticate as: the family is asked once instead', async () => {
    const { familyId } = await seedFamily({
      mail: [
        { domain: BOARD, auth: 'unaligned' },
        { domain: OTHER_BOARD, auth: 'forged_below' },
      ],
    });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(gmailReads).toHaveLength(2);
    expect(script.searches).toEqual([]);
    expect(bodyReads).toEqual([]);
    expect(result).toMatchObject({ unaligned: 2, recorded: 0, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('a private school or university names the school only as the authenticated sender of kept kid mail', async () => {
    const { familyId } = await seedFamily({
      mail: [
        BOARD,
        { domain: 'university.example', auth: 'forged_below' },
        'private-school.example',
      ],
    });
    // The private school's open-house mail was the parent's own, by their word.
    await verdictOn(familyId, `msg-${seq}`, 'adult');
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches).toEqual([BOARD]);
    expect(result).toMatchObject({ recorded: 1, unaligned: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
    });

    // Its own authenticated kid mail does name it, and then it is weighed like any school.
    const other = await seedFamily({ mail: ['private-school.example'] });
    await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(script.searches).toContain('private-school.example');
    expect(await loadSchoolBreak(db.database, other.familyId, '2026-27')).toMatchObject({
      boardHost: 'private-school.example',
      firstDay: '2026-12-19',
    });
  });

  it("reads no mail the parent or the kid check called the parent's own, nor a 13+ child's", async () => {
    const { familyId } = await seedFamily({ mail: [BOARD, OTHER_BOARD] });
    await verdictOn(familyId, `msg-${seq - 1}`, 'adult');
    await verdictOn(familyId, `msg-${seq}`, 'kid', true);
    const script = scripted();
    await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(gmailReads).toEqual([]);
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('reads no mail from a connection that is no longer active', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD], gmailStatus: 'revoked' });
    const script = scripted();
    await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(gmailReads).toEqual([]);
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toHaveLength(1);
  });

  it("lists only the family's own alerts, and reads only its own active connection that holds the read scope", async () => {
    const one = await seedFamily({ mail: [BOARD] });
    const two = await seedFamily({ mail: [OTHER_BOARD] });
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
    const { familyId } = await seedFamily({ mail: [BOARD] });
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
});

describe('the winter-break sweep: which dates', () => {
  it("reads the board once for every family on its host and files each family's break", async () => {
    const one = await seedFamily({ mail: [BOARD] });
    const two = await seedFamily({ mail: [BOARD] });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches).toEqual([BOARD]);
    expect(result).toMatchObject({ lookedUp: 1, verified: 1, recorded: 2, queued: 0 });
    for (const { familyId } of [one, two]) {
      expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
        source: 'board_page',
        boardHost: BOARD,
      });
    }
    // The next hour: the cache is fresh and the facts already say it.
    const again = await runSchoolBreakSweep(
      db.database,
      deps(script.lookup),
      new Date(NOW.getTime() + HOUR),
    );
    expect(script.searches).toEqual([BOARD]);
    expect(again).toMatchObject({ lookedUp: 0, recorded: 0 });
    expect(await audits(one.familyId, 'school_break_recorded')).toHaveLength(1);
  });

  it('hands the break question the board break, through the production context', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    const context = await loadWeekdayCareContext(db.database, familyId, NOW);
    expect(context.verifiedBreak).toEqual({
      eventKey: 'winter-break-2026-12-21',
      label: 'Winter Break',
      date: '2026-12-21',
      source: 'school_calendar',
    });
  });

  it("reads the break off the school email's own text when its host has no calendar page, quoted", async () => {
    const { familyId } = await seedFamily({
      mail: [{ domain: 'school.example', body: EMAIL_BODY }],
    });
    const script = scripted({
      search: () => ({ outcome: 'none', reason: 'no_calendar_page' }),
      textJson: () => EMAIL_JSON,
    });

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.texts).toEqual([EMAIL_BODY]);
    expect(result).toMatchObject({ notFound: 1, emailRead: 1, recorded: 1, queued: 0 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      source: 'school_email',
      name: 'Winter Break',
      firstDay: '2026-12-21',
      lastDay: '2027-01-01',
      sourceUrl: null,
      boardHost: 'school.example',
      quotes: [EMAIL_RANGE],
    });
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toMatchObject({
      source: 'connected_email',
      date: '2026-12-21',
    });
    expect(await asks(familyId)).toEqual([]);
  });

  it('files nothing from an email whose text does not carry the days the model gave', async () => {
    const { familyId } = await seedFamily({
      mail: [{ domain: 'school.example', body: 'Curriculum night Thursday.' }],
    });
    const script = scripted({
      search: () => ({ outcome: 'none', reason: 'no_calendar_page' }),
      textJson: () => EMAIL_JSON,
    });
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(script.texts).toHaveLength(1);
    expect(result).toMatchObject({ emailRead: 1, recorded: 0, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
  });

  it('asks once, per family, when no page or email has the days, and never again this school year', async () => {
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
      what: 'winter break 2026-27',
      why: 'school_break_ask year=2026-27',
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

  it('files no break and asks the parent once when two schools disagree on the days', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD, OTHER_BOARD] });
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(result).toMatchObject({ verified: 2, disagreed: 1, recorded: 0, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
  });

  it('files the break when two schools give the same days', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD, OTHER_BOARD] });
    const script = scripted({ read: (url) => ({ ...WINTER, sourceUrl: url }) });
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result).toMatchObject({ verified: 2, recorded: 1, queued: 0 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      firstDay: '2026-12-21',
      boardHost: BOARD,
    });
  });

  it('reads the mail again the next day with a board break on file, and asks when a second school disagrees', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
    });
    await alertFrom(familyId, OTHER_BOARD);
    const result = await runSchoolBreakSweep(
      db.database,
      deps(scripted().lookup),
      new Date(NOW.getTime() + 25 * HOUR),
    );
    expect(gmailReads).toHaveLength(3);
    expect(result).toMatchObject({ disagreed: 1, recorded: 0, queued: 1 });
  });

  it("leaves a parent's own answer alone: no lookup, no question, no write over it", async () => {
    const { familyId, parentIds } = await seedFamily({ mail: [BOARD] });
    await recordSchoolBreak(db.database, {
      source: 'parent',
      familyId,
      parentUserId: parentIds[0] as string,
      schoolYear: '2026-27',
      name: null,
      firstDay: '2026-12-18',
      lastDay: '2027-01-04',
      quote: 'dec 18 to jan 4',
      now: NOW,
    });
    const script = scripted();
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result).toMatchObject({ parentKnown: 1, lookedUp: 0, recorded: 0, queued: 0 });
    expect(script.searches).toEqual([]);
    // No name was given, and none is made up.
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toEqual({
      eventKey: 'winter-break-2026-12-18',
      label: null,
      date: '2026-12-18',
      source: 'parent_said',
    });
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
});

describe('the winter-break sweep: who', () => {
  it('reads nothing while the kill switch is off', async () => {
    vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, 'false');
    const { familyId } = await seedFamily({ mail: [BOARD] });
    const script = scripted();
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(result.skipped).toBe('flag_off');
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toEqual([]);
  });

  it('never files a board break for, or asks, a daycare-only family', async () => {
    // A four-year-old the parent said is at daycare, with school mail from a board.
    const { familyId, parentIds, childId } = await seedFamily({
      mail: [BOARD],
      dateOfBirth: '2022-05-01',
    });
    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId: parentIds[0] as string,
      childId,
      care: 'daycare',
      provider: null,
      now: NOW,
    });
    // And a toddler at daycare, too young for school by any reading.
    const toddler = await seedFamily({ mail: [BOARD], dateOfBirth: '2023-05-01' });
    await recordWeekdayCare(db.database, {
      familyId: toddler.familyId,
      parentUserId: toddler.parentIds[0] as string,
      childId: toddler.childId,
      care: 'daycare',
      provider: null,
      now: NOW,
    });
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(result).toMatchObject({ noSchoolChild: 2, recorded: 0, queued: 0 });
    expect(gmailReads).toEqual([]);
    expect(script.searches).toEqual([]);
    for (const id of [familyId, toddler.familyId]) {
      expect(await loadSchoolBreak(db.database, id, '2026-27')).toBeNull();
      expect(await asks(id)).toEqual([]);
      expect((await loadWeekdayCareContext(db.database, id, NOW)).verifiedBreak).toBeNull();
    }
  });

  it('counts a child from the school year they turn four through the year they turn eighteen', async () => {
    const jk = await seedFamily({ dateOfBirth: '2022-11-15' });
    const notYet = await seedFamily({ dateOfBirth: '2023-01-10' });
    const gradeTwelve = await seedFamily({ dateOfBirth: '2009-02-01' });
    const graduated = await seedFamily({ dateOfBirth: '2008-12-01' });
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(result).toMatchObject({ noSchoolChild: 2, queued: 2 });
    expect(await asks(jk.familyId)).toHaveLength(1);
    expect(await asks(gradeTwelve.familyId)).toHaveLength(1);
    expect(await asks(notYet.familyId)).toEqual([]);
    expect(await asks(graduated.familyId)).toEqual([]);
  });

  it('asks nothing once the winter break is too close to plan around', async () => {
    const { familyId } = await seedFamily();
    const late = new Date('2026-12-16T15:00:00Z');
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), late);
    expect(result).toMatchObject({ tooLate: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
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
    const { familyId } = await seedFamily({ mail: [BOARD] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).not.toBeNull();
    vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, 'false');
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toBeNull();
  });
});

describe('the winter-break sweep: bounds', () => {
  it('waits while a lookup has not finished, then after a bounded number of tries asks, by name', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    const script = scripted({ search: () => ({ outcome: 'failed', reason: 'search_failed:x' }) });
    const info = vi.spyOn(console, 'info');

    for (let i = 0; i < MAX_LOOKUP_TRIES - 1; i++) {
      const result = await runSchoolBreakSweep(
        db.database,
        deps(script.lookup),
        new Date(NOW.getTime() + i * HOUR),
      );
      expect(result).toMatchObject({ retry: 1, waiting: 1, queued: 0 });
      expect(await asks(familyId)).toEqual([]);
    }
    const last = await runSchoolBreakSweep(
      db.database,
      deps(script.lookup),
      new Date(NOW.getTime() + (MAX_LOOKUP_TRIES - 1) * HOUR),
    );

    expect(script.searches).toHaveLength(MAX_LOOKUP_TRIES);
    expect(last).toMatchObject({ retriesExhausted: 1, waiting: 0, queued: 1 });
    expect(await asks(familyId)).toHaveLength(1);
    expect(info.mock.calls.some(([, line]) => line === 'school break: lookup tries ran out')).toBe(
      true,
    );
    info.mockRestore();
  });

  it('counts a missing model client by name and asks nothing for a school it could not read', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    const result = await runSchoolBreakSweep(db.database, deps(null), NOW);
    expect(result).toMatchObject({ noClient: 1, waiting: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);
  });

  it('reads the mail of the families served longest ago first, so none is starved', async () => {
    const total = MAX_MAIL_READS_PER_RUN + 2;
    const families: string[] = [];
    for (let i = 0; i < total; i++) families.push((await seedFamily({ mail: [BOARD] })).familyId);
    // A lookup that never finishes keeps every family waiting, and its mail unsettled.
    const script = scripted({ search: () => ({ outcome: 'failed', reason: 'search_failed:x' }) });

    await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    const first = new Set(await Promise.all(gmailReads.map(familyOfMessage)));
    expect(first.size).toBe(MAX_MAIL_READS_PER_RUN);
    gmailReads.length = 0;

    await runSchoolBreakSweep(db.database, deps(script.lookup), new Date(NOW.getTime() + HOUR));
    const second = new Set(await Promise.all(gmailReads.map(familyOfMessage)));
    const unserved = families.filter((id) => !first.has(id));
    expect(unserved).toHaveLength(2);
    for (const id of unserved) expect(second.has(id)).toBe(true);
  });

  it("reads a family's mail at most once a day once it settled", async () => {
    const { familyId } = await seedFamily({ mail: [{ domain: BOARD, auth: 'unaligned' }] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(gmailReads).toHaveLength(1);
    // With the family still open (its ask cleared here), its mail is not read again that day.
    await db.database
      .delete(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, familyId));
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), new Date(NOW.getTime() + HOUR));
    expect(gmailReads).toHaveLength(1);
    await db.database
      .delete(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, familyId));
    await runSchoolBreakSweep(
      db.database,
      deps(scripted().lookup),
      new Date(NOW.getTime() + 25 * HOUR),
    );
    expect(gmailReads).toHaveLength(2);
  });
});
