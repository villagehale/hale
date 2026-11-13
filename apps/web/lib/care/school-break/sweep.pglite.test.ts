import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { loadWeekdayCareContext, recordWeekdayCare } from '~/lib/care/weekday';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import {
  SCHOOL_BREAK_ASK_TEMPLATE_KEY,
  parseWeekdayAskKey,
  schoolBreakAskDedupeKey,
} from '~/lib/channel/weekday-care/key';
import { loadAgentContext } from '~/lib/coach/context';
import { CONNECTOR_SCOPES } from '~/lib/integrations/google-oauth';
import type { GoogleFetch } from '~/lib/integrations/sync';
import { assembleMemoryBrief } from '~/lib/memory/brief';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { SCHOOL_BREAK_FACT_KEY, loadSchoolBreak, recordSchoolBreak } from './facts';
import { SCHOOL_BREAK_ENABLED_ENV } from './flag';
import type { BoardLookupDeps } from './lookup';
import { type BreakPageReading, type SchoolBreakExtraction, createTextBreakReader } from './read';
import { productionSchoolMailPorts, schoolMailReader } from './school-mail';
import { type SchoolSenderExtraction, createSchoolSenderReader } from './school-sender';
import type { CalendarSearch } from './search';
import { MAX_LOOKUP_TRIES } from './store';
import {
  MAX_BOARD_LOOKUPS_PER_RUN,
  MAX_MAIL_READS_PER_RUN,
  SCHOOL_BREAK_ASK_KIND,
  SCHOOL_BREAK_MAIL_SERVED_SWEEP,
  type SchoolBreakSweepDeps,
  defaultSchoolBreakSweepDeps,
  runSchoolBreakSweep,
} from './sweep';

/**
 * The winter-break sweep against real Postgres, through the production mail reader:
 * the per-host cache, the family fact, the decider queue and the audit rows are the real
 * ones, and so is the weekday context the break question reads. Only the edges are
 * stipulated: Gmail's answers (headers and bodies, at its fetch), the calendar search and
 * page fetch, and the model's JSON for an email's text (who wrote it, and the break it
 * states), which then goes through the real checks (the model's own readings are the
 * school-break eval's, hard rule #8). The gate's
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

/** The words a school's own email signs with: what the sender check quotes. */
const SCHOOL_WORDS = 'Example Public School';

/** What the model says of who wrote an email: stipulated JSON, checked by real code. */
const WROTE_IT: Record<'school' | 'daycare' | 'other', SchoolSenderExtraction> = {
  school: { reason: 'The school office wrote it.', sender: 'school', school_words: SCHOOL_WORDS },
  daycare: { reason: 'A child care centre wrote it.', sender: 'daycare', school_words: null },
  other: { reason: 'A business wrote it.', sender: 'other', school_words: null },
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
    senderJson?: (text: string, host: string) => SchoolSenderExtraction;
  } = {},
) {
  const searches: string[] = [];
  const reads: string[] = [];
  const texts: string[] = [];
  const senders: string[] = [];
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
    readSender: createSchoolSenderReader(async (host, text) => {
      senders.push(host);
      return over.senderJson ? over.senderJson(text, host) : WROTE_IT.school;
    }),
  };
  return { lookup, searches, reads, texts, senders };
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
  // The address a coach or a parent writes from is their own; a school's is the office's.
  const local = domain === 'gmail.com' ? 'coach.sam' : 'office';
  const [gmail] = await db.database
    .select({ id: schema.integrations.id, userId: schema.integrations.userId })
    .from(schema.integrations)
    .where(eq(schema.integrations.familyId, familyId));
  seq += 1;
  const messageId = `msg-${seq}`;
  inbox.set(messageId, {
    from: `School Office <${local}@${domain}>`,
    auth: auth ?? 'aligned',
    body: body ?? `Curriculum night is Thursday at 6:30.\n\n${SCHOOL_WORDS} office`,
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
  verdict: 'adult' | 'kid' | 'unsure',
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
const EMAIL_BODY = `Dear families,\n\nA reminder that ${EMAIL_RANGE} Classes resume on Monday, January 4, 2027.\n\n${SCHOOL_WORDS} office`;
const EMAIL_JSON: SchoolBreakExtraction = {
  board_on_page: null,
  name: 'Winter Break',
  year_evidence: null,
  first_day: { quote: EMAIL_RANGE, date_text: 'Monday, December 21, 2026', date: '2026-12-21' },
  last_day: { quote: EMAIL_RANGE, date_text: 'Friday, January 1, 2027', date: '2027-01-01' },
  found: true,
};

const PLATFORMS = [
  'schoolcashonline.com',
  'synrevoice.com',
  'schoolday.com',
  'powerschool.com',
  'finalsite.net',
  'myschoolapp.com',
  'edlio.com',
  'blackbaud.com',
  'veracross.com',
  'eventbrite.com',
];

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

  it('never takes a free-mail, mailer or shared platform domain as a school: a coach on gmail, a daycare app, Google Classroom', async () => {
    // A four-year-old the parent never said is at daycare.
    const { familyId } = await seedFamily({
      dateOfBirth: '2022-05-01',
      mail: [
        { domain: 'gmail.com', body: `No practice over ${EMAIL_RANGE}` },
        { domain: 'mybrightwheel.com', body: `The centre is closed: ${EMAIL_RANGE}` },
        { domain: 'classroom.google.com', body: `${EMAIL_RANGE}\n${SCHOOL_WORDS}` },
      ],
    });
    // Payment, notification and website platforms schools send through.
    const platforms = await seedFamily({
      mail: PLATFORMS.map((domain) => ({ domain, body: `${EMAIL_RANGE}\n${SCHOOL_WORDS}` })),
    });
    const script = scripted({ textJson: () => EMAIL_JSON });

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(gmailReads).toHaveLength(3 + PLATFORMS.length);
    expect(bodyReads).toEqual([]);
    expect(script.senders).toEqual([]);
    expect(script.searches).toEqual([]);
    expect(result).toMatchObject({ sharedSender: 3 + PLATFORMS.length, recorded: 0, queued: 2 });
    expect(await loadSchoolBreak(db.database, platforms.familyId, '2026-27')).toBeNull();
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await asks(familyId))[0]?.what).toBe('winter break 2026-27');
  });

  it('names no school from authenticated mail the email shows a school did not write: a camp, a daycare, an open house', async () => {
    const { familyId } = await seedFamily({
      dateOfBirth: '2022-05-01',
      mail: [
        {
          domain: 'camp.example',
          body: `Winter camp for ${SCHOOL_WORDS} families runs while school is out: ${EMAIL_RANGE}`,
        },
        { domain: 'little-sprouts.example', body: `We are closed ${EMAIL_RANGE}` },
        { domain: 'private-school.example', body: 'Join our open house for next fall.' },
      ],
    });
    const script = scripted({
      textJson: () => EMAIL_JSON,
      senderJson: (_text, host) =>
        host === 'little-sprouts.example'
          ? WROTE_IT.daycare
          : host === 'camp.example'
            ? // The camp's email names the school it serves; a camp still wrote it.
              { ...WROTE_IT.other, school_words: SCHOOL_WORDS }
            : WROTE_IT.other,
    });

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect([...script.senders].sort()).toEqual([
      'camp.example',
      'little-sprouts.example',
      'private-school.example',
    ]);
    expect(script.searches).toEqual([]);
    expect(script.texts).toEqual([]);
    expect(result).toMatchObject({ notSchool: 3, recorded: 0, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await asks(familyId))[0]?.what).toBe('winter break 2026-27');
  });

  it('names no school when the model says school but the email does not carry the words it named', async () => {
    const { familyId } = await seedFamily({ mail: [{ domain: BOARD, body: 'See you Thursday.' }] });
    const script = scripted();
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(script.senders).toEqual([BOARD]);
    expect(script.searches).toEqual([]);
    expect(result).toMatchObject({ notSchool: 1, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
  });

  it('reads no mail the kid check was unsure about', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    await verdictOn(familyId, `msg-${seq}`, 'unsure');
    const script = scripted();
    await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(gmailReads).toEqual([]);
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toHaveLength(1);
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

  it("files nothing off a school email's text: its days are put to the parent, quoted, in the one ask", async () => {
    const { familyId } = await seedFamily({
      mail: [{ domain: 'school.example', body: EMAIL_BODY }],
    });
    const script = scripted({
      search: () => ({ outcome: 'none', reason: 'no_calendar_page' }),
      textJson: () => EMAIL_JSON,
    });

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.senders).toEqual(['school.example']);
    expect(script.texts).toEqual([EMAIL_BODY]);
    expect(bodyReads).toHaveLength(1);
    expect(result).toMatchObject({ notFound: 1, emailRead: 1, recorded: 0, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toBeNull();
    const [ask, ...more] = await asks(familyId);
    expect(more).toEqual([]);
    expect(ask).toMatchObject({
      what: 'winter break 2026-27; the school email gives Winter Break 2026-12-21 to 2027-01-01',
      why: 'school_break_ask year=2026-27',
    });
  });

  it('files nothing from an email whose text does not carry the days the model gave, and asks plainly', async () => {
    const { familyId } = await seedFamily({
      mail: [{ domain: 'school.example', body: `Curriculum night Thursday.\n${SCHOOL_WORDS}` }],
    });
    const script = scripted({
      search: () => ({ outcome: 'none', reason: 'no_calendar_page' }),
      textJson: () => EMAIL_JSON,
    });
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);
    expect(script.texts).toHaveLength(1);
    expect(result).toMatchObject({ emailRead: 1, recorded: 0, queued: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await asks(familyId))[0]?.what).toBe('winter break 2026-27');
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
    expect(result).toMatchObject({ disagreed: 1, recorded: 0, retired: 1, queued: 1 });
    // The school filed first is not kept for being first: neither school's days stand.
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect(
      (await loadWeekdayCareContext(db.database, familyId, new Date(NOW.getTime() + 25 * HOUR)))
        .verifiedBreak,
    ).toBeNull();
    const [retired] = await audits(familyId, 'school_break_retired');
    expect(retired?.after).toMatchObject({ reason: 'schools_disagree', boardHost: BOARD });
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

  it('stops waiting on a school it cannot read once December starts, and asks', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    const december = new Date('2026-12-01T15:00:00Z');
    const result = await runSchoolBreakSweep(db.database, deps(null), december);
    expect(result).toMatchObject({ noClient: 1, waiting: 0, waitedOut: 1, queued: 1 });
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('looks up the school of the family waiting longest first, however few families it has', async () => {
    const busy = ['busy-a.example', 'busy-b.example', 'busy-c.example'];
    expect(busy.length).toBe(MAX_BOARD_LOOKUPS_PER_RUN);
    const lonely = await seedFamily({ mail: ['lonely.example'] });
    const crowd = [await seedFamily({ mail: busy }), await seedFamily({ mail: busy })];
    const served = [lonely, ...crowd].map((family, i) => ({
      familyId: family.familyId,
      sweep: SCHOOL_BREAK_MAIL_SERVED_SWEEP,
      sweptAt: new Date(NOW.getTime() - (10 - i) * HOUR),
    }));
    await db.database.insert(schema.familySweepMarks).values(served);
    const script = scripted();

    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), NOW);

    expect(script.searches[0]).toBe('lonely.example');
    expect(script.searches).toHaveLength(MAX_BOARD_LOOKUPS_PER_RUN);
    expect(result.deferred).toBe(1);
    expect(await loadSchoolBreak(db.database, lonely.familyId, '2026-27')).toMatchObject({
      boardHost: 'lonely.example',
    });
  });
});

describe('the winter-break sweep: one ask per school year, each check pinned on its own', () => {
  const LATER = new Date(NOW.getTime() + 25 * HOUR);

  it('reads no mail and checks no sender for a family already asked this year with nothing on file', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    const first = await runSchoolBreakSweep(
      db.database,
      deps(scripted({ read: (url) => ({ status: 'not_published', sourceUrl: url }) }).lookup),
      NOW,
    );
    expect(first).toMatchObject({ queued: 1 });
    // Positive control: the first run did read the mail.
    expect(gmailReads).toHaveLength(1);
    await alertFrom(familyId, OTHER_BOARD);
    gmailReads.length = 0;

    const script = scripted();
    const again = await runSchoolBreakSweep(db.database, deps(script.lookup), LATER);

    expect(again).toMatchObject({ asked: 1, queued: 0 });
    expect(gmailReads).toEqual([]);
    expect(script.senders).toEqual([]);
    expect(script.searches).toEqual([]);
    expect(await asks(familyId)).toHaveLength(1);
  });

  it('never asks a second parent when a break on file falls to a disagreeing school after the household was asked', async () => {
    const { familyId, parentIds } = await seedFamily({ mail: [BOARD], parents: 2 });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
    });
    // This year's ask already went to the co-parent: the household has been asked.
    const coParent = parentIds[1] as string;
    await queueCheckInForDecider(db.database, {
      familyId,
      parentUserId: coParent,
      kind: SCHOOL_BREAK_ASK_KIND,
      category: 'nudge',
      templateKey: SCHOOL_BREAK_ASK_TEMPLATE_KEY,
      what: 'winter break 2026-27',
      why: 'school_break_ask year=2026-27',
      sourceUrl: null,
      worthlessAfter: new Date('2026-12-15T17:00:00.000Z'),
      parentRequested: false,
      dedupeKey: schoolBreakAskDedupeKey(familyId, '2026-27', coParent),
    });
    await alertFrom(familyId, OTHER_BOARD);

    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), LATER);

    expect(result).toMatchObject({ disagreed: 1, retired: 1, queued: 0, asked: 1 });
    const [only, ...more] = await asks(familyId);
    expect(more).toEqual([]);
    expect(only?.parentUserId).toBe(coParent);
  });
});

describe('the winter-break sweep: a filed break stands only on what named it', () => {
  const LATER = new Date(NOW.getTime() + 25 * HOUR);

  it('retires a board break once the parent says the mail that named the school was theirs, and the break question stops naming it at once', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    const messageId = `msg-${seq}`;
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
    });

    // "That's mine": the shape the untrack writes, landing after the break was filed.
    await verdictOn(familyId, messageId, 'adult');
    // Before any sweep runs, the break question already reads no break.
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toBeNull();

    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), LATER);

    expect(result).toMatchObject({ retired: 1, recorded: 0 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await loadWeekdayCareContext(db.database, familyId, LATER)).verifiedBreak).toBeNull();
    const [retired, ...more] = await audits(familyId, 'school_break_retired');
    expect(more).toEqual([]);
    expect(retired?.after).toMatchObject({ reason: 'source_mail_withdrawn', boardHost: BOARD });
    // With nothing else naming a school, the parent is asked, once.
    expect(await asks(familyId)).toHaveLength(1);
  });

  it.each([
    ['on', ''],
    ['off', 'false'],
  ])(
    'never shows the coach a board break whose mail was withdrawn or whose child left school age (lane %s)',
    async (_lane, flag) => {
      const { familyId, parentIds, childId } = await seedFamily({
        mail: [BOARD],
        dateOfBirth: '2022-05-01',
      });
      await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
      vi.stubEnv(SCHOOL_BREAK_ENABLED_ENV, flag);
      // Both ways a fact reaches the coach, which must agree: its memory brief, and its
      // memory facts.
      const told = async (): Promise<boolean> => {
        const brief = (await assembleMemoryBrief(db.database, familyId, 'every_adult', NOW)).text;
        const context = await loadAgentContext(
          {
            familyId,
            question: 'when is winter break?',
            intent: null,
            focusedChildId: null,
            transcript: [],
            sourceNote: null,
          },
          db.database,
          NOW,
        );
        const inFacts = context.memoryFacts.some((fact) => fact.factKey === SCHOOL_BREAK_FACT_KEY);
        expect(inFacts).toBe(brief.includes(SCHOOL_BREAK_FACT_KEY));
        return inFacts;
      };
      // Positive control: while it stands, the coach is told it.
      expect(await told()).toBe(true);

      await recordWeekdayCare(db.database, {
        familyId,
        parentUserId: parentIds[0] as string,
        childId,
        care: 'daycare',
        provider: null,
        now: NOW,
      });
      expect(await told()).toBe(false);

      // The parent corrects it: home after all, so the break stands again.
      await recordWeekdayCare(db.database, {
        familyId,
        parentUserId: parentIds[0] as string,
        childId,
        care: 'home',
        provider: null,
        now: NOW,
      });
      expect(await told()).toBe(true);
      await verdictOn(familyId, `msg-${seq}`, 'adult');
      expect(await told()).toBe(false);
      // Still filed: only a sweep retires it, and none has run.
      expect(await loadSchoolBreak(db.database, familyId, '2026-27')).not.toBeNull();
    },
  );

  it('keeps a board break while any mail from that school is still kept kid mail, and retires it when none is', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD, BOARD] });
    const newest = `msg-${seq}`;
    const older = `msg-${seq - 1}`;
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    // Every kept message from the school, not only the one the school check read.
    const filed = await loadSchoolBreak(db.database, familyId, '2026-27');
    expect(filed?.sourceMail.map((mail) => mail.messageId).sort()).toEqual([newest, older].sort());

    // The message the school check read is withdrawn; the school's other notice stands.
    await verdictOn(familyId, newest, 'adult');
    const kept = await runSchoolBreakSweep(db.database, deps(scripted().lookup), LATER);
    expect(kept).toMatchObject({ retired: 0 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
    });

    // The last kept mail from that school is withdrawn too: nothing names it any more.
    await verdictOn(familyId, older, 'adult');
    const gone = await runSchoolBreakSweep(
      db.database,
      deps(scripted().lookup),
      new Date(LATER.getTime() + 25 * HOUR),
    );
    expect(gone).toMatchObject({ retired: 1 });
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
  });

  it('retires a board break once the parent says the only school-age child is at daycare, and never asks about a board', async () => {
    const { familyId, parentIds, childId } = await seedFamily({
      mail: [BOARD],
      dateOfBirth: '2022-05-01',
    });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
    });

    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId: parentIds[0] as string,
      childId,
      care: 'daycare',
      provider: null,
      now: NOW,
    });
    expect((await loadWeekdayCareContext(db.database, familyId, NOW)).verifiedBreak).toBeNull();

    const script = scripted();
    const result = await runSchoolBreakSweep(db.database, deps(script.lookup), LATER);

    expect(result).toMatchObject({ noSchoolChild: 1, retired: 1, queued: 0 });
    expect(script.searches).toEqual([]);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toBeNull();
    expect((await loadWeekdayCareContext(db.database, familyId, LATER)).verifiedBreak).toBeNull();
    const [retired] = await audits(familyId, 'school_break_retired');
    expect(retired?.after).toMatchObject({ reason: 'no_school_child' });
    expect(await asks(familyId)).toEqual([]);
  });

  it("leaves the parent's own answer standing whatever the mail or the care later says", async () => {
    const { familyId, parentIds, childId } = await seedFamily({ dateOfBirth: '2022-05-01' });
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
    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId: parentIds[0] as string,
      childId,
      care: 'daycare',
      provider: null,
      now: NOW,
    });
    const result = await runSchoolBreakSweep(db.database, deps(scripted().lookup), LATER);
    expect(result).toMatchObject({ retired: 0 });
    expect(
      (await loadWeekdayCareContext(db.database, familyId, LATER)).verifiedBreak,
    ).toMatchObject({ source: 'parent_said', date: '2026-12-18' });
  });
});

describe('the winter-break sweep: transient failures', () => {
  it('waits, by name, when the sender check or the email text could not be read, and reads it again next hour', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    const failing = scripted({
      senderJson: () => {
        throw new ZodError([]);
      },
    });

    const result = await runSchoolBreakSweep(db.database, deps(failing.lookup), NOW);

    expect(result).toMatchObject({ emailUnread: 1, notSchool: 0, waiting: 1, queued: 0 });
    expect(await asks(familyId)).toEqual([]);

    const healed = scripted();
    const next = await runSchoolBreakSweep(
      db.database,
      deps(healed.lookup),
      new Date(NOW.getTime() + HOUR),
    );
    expect(healed.senders).toEqual([BOARD]);
    expect(next).toMatchObject({ recorded: 1, queued: 0 });
  });

  it('bounds the lookups of a host whose earlier reading is stale: after the tries run out the families on file keep their break and the host rests', async () => {
    const { familyId } = await seedFamily({ mail: [BOARD] });
    await runSchoolBreakSweep(db.database, deps(scripted().lookup), NOW);
    const failing = scripted({ search: () => ({ outcome: 'failed', reason: 'search_failed:x' }) });
    const eightDays = NOW.getTime() + 8 * 24 * HOUR;
    const outcomes = [];
    for (let h = 0; h < MAX_LOOKUP_TRIES + 2; h++) {
      outcomes.push(
        await runSchoolBreakSweep(
          db.database,
          deps(failing.lookup),
          new Date(eightDays + h * HOUR),
        ),
      );
    }
    expect(failing.searches).toHaveLength(MAX_LOOKUP_TRIES);
    expect(outcomes.map((r) => r.retriesExhausted)).toEqual([0, 0, 1, 0, 0]);
    expect(await loadSchoolBreak(db.database, familyId, '2026-27')).toMatchObject({
      boardHost: BOARD,
      firstDay: '2026-12-21',
    });
  });
});
