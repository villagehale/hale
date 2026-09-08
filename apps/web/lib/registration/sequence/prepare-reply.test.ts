import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SpotUrlRefusal, sanitizeSpotUrl } from '~/lib/channel/spots/url';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  COURSE_BIND_REFUSALS,
  type CourseBindRefusal,
  type PrepareReplyDeps,
  type PreparingSequence,
  defaultPrepareReplyDeps,
  handleCourseBind,
  handleReadinessAnswer,
  loadPreparingSequence,
  readinessQuestion,
} from './prepare-reply';

/**
 * VIL-338 · the inbound half, against the REAL DDL and the bytes a PerfectMind page
 * actually served.
 *
 * TWO THINGS ARE PROVEN HERE AND CAN ONLY BE PROVEN AGAINST POSTGRES. The two writers
 * are guarded UPDATEs whose "no row" answer IS the idempotency ("already bound",
 * "already answered"), and the readiness question's openness is a comparison of two
 * timestamps in the message ledger. A Drizzle chain fake returns whatever rows it was
 * handed and would pass against a table with neither column and a source that never
 * read the ledger at all.
 *
 * The ONE injected effect is the network: `fetchBody` is a function per case, so no
 * test reaches a municipality.
 *
 * Each test names the mutation it exists to kill.
 */

const FIXTURES = join(__dirname, '..', '..', 'channel', 'spots', 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.html`), 'utf8');

/** Course GUIDs, read off each fixture's own `EventId`. */
const LEGO = '961140fe-0866-460f-9973-7c42cbe0a928';
const CHESS = '85770d4d-bce9-4e53-b969-cf7e88775180';
const OAKVILLE_COURSE = '16765c8e-835f-4ba6-9803-bbc84bd5ff8f';

const legoUrl = `https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=${LEGO}`;
const chessUrl = `https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=${CHESS}`;
const oakvilleUrl = `https://townofoakville.perfectmind.com/Contacts/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=${OAKVILLE_COURSE}`;

/** The page publishes residents 2026-08-11T06:30 and public 2026-08-12T06:30, both
 * naive local. The shipped Markham M1 row carries ONE instant, the resident one. */
const RESIDENT_CLOCK = new Date('2026-08-11T06:30:00-04:00');
const PUBLIC_CLOCK = new Date('2026-08-12T06:30:00-04:00');
const MARKHAM_ROW_OPEN_AT = RESIDENT_CLOCK;

const NOW = new Date('2026-08-04T12:00:00.000Z');

let db: TestDb;
let familyId: string;
let parentUserId: string;
let windowId: string;
let sequenceId: string;
let inboundId: string;

/** A page server that never reaches the network and fails loudly if a case forgot to
 * say what the portal returns. */
function serving(body: string | (() => never)): PrepareReplyDeps['fetchBody'] {
  return async () => (typeof body === 'string' ? body : body());
}

function deps(overrides: Partial<PrepareReplyDeps> = {}): PrepareReplyDeps {
  return {
    ...defaultPrepareReplyDeps(),
    fetchBody: serving(() => {
      throw new Error('this case must state what the portal serves');
    }),
    ...overrides,
  };
}

let windowSeq = 0;
async function seedWindow(): Promise<string> {
  windowSeq += 1;
  const [row] = await db.database
    .insert(schema.registrationWindows)
    .values({
      municipality: 'markham',
      programDomain: 'rec_program',
      cycleLabel: `Fall 2026 #${windowSeq}`,
      openAt: MARKHAM_ROW_OPEN_AT,
      ageMinMonths: 36,
      ageMaxMonths: 84,
      sourceUrl: 'https://www.markham.ca/register',
      verifiedAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: schema.registrationWindows.id });
  if (!row) throw new Error('seedWindow: no row');
  return row.id;
}

/** An approved shortlist — the opt-in the ladder reads live off the approval spine. */
let seedSeq = 0;
async function seedSequence(): Promise<string> {
  seedSeq += 1;
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'test',
      eventType: 'registration_shortlist',
      dedupHash: `prepare-reply-${seedSeq}-${Math.random()}`,
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('seedSequence: no event');
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event.id,
      familyId,
      actionType: 'send_message',
      payload: {},
      executedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('seedSequence: no action');
  const [row] = await db.database
    .insert(schema.registrationSequences)
    .values({ familyId, windowId, parentUserId, actionId: action.id })
    .returning({ id: schema.registrationSequences.id });
  if (!row) throw new Error('seedSequence: no sequence');
  return row.id;
}

async function setArea(area: string): Promise<void> {
  await db.database
    .update(schema.families)
    .set({ areaCoarse: area })
    .where(eq(schema.families.id, familyId));
}

async function seedInbound(body: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      createdAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('seedInbound: no row');
  return row.id;
}

async function seedOutbound(input: {
  dedupeKey: string | null;
  createdAt: Date;
  status?: 'delivered' | 'suppressed_quiet_hours';
}): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'registration_sequence',
    dedupeKey: input.dedupeKey,
    status: input.status ?? 'delivered',
    createdAt: input.createdAt,
  });
}

async function auditRows(verb: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
}

async function sequenceRow() {
  const [row] = await db.database
    .select()
    .from(schema.registrationSequences)
    .where(eq(schema.registrationSequences.id, sequenceId));
  if (!row) throw new Error('sequenceRow: gone');
  return row;
}

/** The live sequence a case binds against. Fails the test rather than returning null,
 * so a broken loader shows up as a loader failure and not as a silent skip. */
async function preparing(now = NOW): Promise<PreparingSequence> {
  const sequence = await loadPreparingSequence(db.database, familyId, now);
  if (sequence === null) throw new Error('loadPreparingSequence returned null');
  return sequence;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  const seeded = await seedFamily(db.database, `Prepare Reply ${Math.random()}`);
  familyId = seeded.familyId;
  parentUserId = seeded.parentUserId;
  await setArea('L3R');
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2021-08-01', dobPrecision: 'exact' });
  windowId = await seedWindow();
  sequenceId = await seedSequence();
  inboundId = await seedInbound(legoUrl);
});

describe('loadPreparingSequence', () => {
  it('finds the live opted-in pre-open sequence for a portal municipality', async () => {
    const sequence = await preparing();

    expect(sequence).toMatchObject({
      sequenceId,
      familyId,
      parentUserId,
      windowId,
      isResidentWindow: true,
      opensForFamilyAt: MARKHAM_ROW_OPEN_AT,
      courseUrl: null,
      readinessReady: null,
    });
    expect(sequence.portal.municipality).toBe('markham');
  });

  it('is null once the anchor has passed — kills a loader that claims a morning already run', async () => {
    expect(
      await loadPreparingSequence(db.database, familyId, new Date('2026-08-11T11:00:00.000Z')),
    ).toBeNull();
  });

  it('is null while the shortlist is still awaiting approval — kills a widened opt-in read', async () => {
    await db.database
      .update(schema.actions)
      .set({ executedAt: null })
      .where(eq(schema.actions.familyId, familyId));

    expect(await loadPreparingSequence(db.database, familyId, NOW)).toBeNull();
  });

  it('is null for a municipality Hale has never read a portal for', async () => {
    await db.database
      .update(schema.registrationWindows)
      .set({ municipality: 'richmond_hill' })
      .where(eq(schema.registrationWindows.id, windowId));

    expect(await loadPreparingSequence(db.database, familyId, NOW)).toBeNull();
  });
});

describe('the bind refusals', () => {
  const REFUSED_PASTE: Record<SpotUrlRefusal, string> = {
    not_https: legoUrl.replace('https://', 'http://'),
    has_credentials: legoUrl.replace('https://', 'https://someone:pw@'),
    host_not_allowed: legoUrl.replace('cityofmarkham.perfectmind.com', 'example.test'),
    not_a_course_page: 'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/Classes',
    too_long: `${legoUrl}&pad=${'x'.repeat(512)}`,
  };

  /** A paste whose refusal is decided before anything is fetched — the portal serving
   * this is itself the failure. */
  const unfetched = (): never => {
    throw new Error('this refusal must be decided without opening a page');
  };

  /** The same real Markham page with every clock this family could open on removed: a
   * live course that publishes no registration date at all. */
  const noPublishedClock = () =>
    fixture('open-window-open-markham').replace(
      /"(ResidentsRegistrationDateValue|MembersRegistrationDateValue|PublicRegistrationStartDateValue)":"[^"]*"/g,
      '"$1":null',
    );

  /** The same page with its two published clocks moved to the NEXT cycle: six weeks
   * from the M1 row is a different season, not a corrected date. */
  const nextSeason = () =>
    fixture('open-window-open-markham')
      .replace(/2026-08-11T06:30:00/g, '2026-09-22T06:30:00')
      .replace(/2026-08-12T06:30:00/g, '2026-09-23T06:30:00');

  /**
   * Every refusal with the paste AND the page that actually produces it. The five
   * URL-shaped ones and `wrong_municipality` never reach a portal — `unfetched` is the
   * proof — and each page-shaped one gets its own bytes, so no reason can quietly reach
   * this loop through another reason's verdict.
   */
  const DRIVES: Record<CourseBindRefusal, { rawUrl: string; page: () => string }> = {
    not_https: { rawUrl: REFUSED_PASTE.not_https, page: unfetched },
    has_credentials: { rawUrl: REFUSED_PASTE.has_credentials, page: unfetched },
    host_not_allowed: { rawUrl: REFUSED_PASTE.host_not_allowed, page: unfetched },
    not_a_course_page: { rawUrl: REFUSED_PASTE.not_a_course_page, page: unfetched },
    too_long: { rawUrl: REFUSED_PASTE.too_long, page: unfetched },
    wrong_municipality: { rawUrl: oakvilleUrl, page: unfetched },
    page_unreadable: {
      rawUrl: legoUrl,
      page: () => {
        throw new Error('ETIMEDOUT');
      },
    },
    course_gone: { rawUrl: legoUrl, page: () => fixture('markham-course-not-found') },
    no_published_clock: { rawUrl: legoUrl, page: noPublishedClock },
    different_season: { rawUrl: legoUrl, page: nextSeason },
  };

  /**
   * Kills three things at once: a reason that never reaches its own refusal (drive each
   * one from the page that causes it and assert the reason back), a reason that shares
   * another's sentence, and a writer that runs before the paste has been judged.
   */
  it('reaches every refusal by its own cause, in its own sentence, and writes nothing', async () => {
    const sequence = await preparing();
    const sentences = new Set<string>();

    for (const reason of COURSE_BIND_REFUSALS) {
      const drive = DRIVES[reason];
      const outcome = await handleCourseBind(
        db.database,
        { sequence, rawUrl: drive.rawUrl, inboundChannelMessageId: inboundId, now: NOW },
        deps({ fetchBody: async () => drive.page() }),
      );

      expect(outcome).toMatchObject({ status: 'refused', reason });
      if (outcome.status !== 'refused') throw new Error('unreachable');
      expect(outcome.reply.length).toBeGreaterThan(20);
      expect(outcome.reply).not.toMatch(/https?:\/\//);
      sentences.add(outcome.reply);
    }

    expect(sentences.size).toBe(COURSE_BIND_REFUSALS.length);
    expect(await auditRows('registration_course_bound')).toHaveLength(0);
    expect(await auditRows('registration_readiness_stated')).toHaveLength(0);
    const row = await sequenceRow();
    expect(row.courseUrl).toBeNull();
    expect(row.courseOpensAt).toBeNull();
    expect(row.readinessReady).toBeNull();
  });

  it('refuses another municipality’s portal by naming the morning it is holding', async () => {
    const sequence = await preparing();

    const outcome = await handleCourseBind(
      db.database,
      { sequence, rawUrl: oakvilleUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({ fetchBody: serving(fixture('oakville-course')) }),
    );

    expect(outcome).toMatchObject({ status: 'refused', reason: 'wrong_municipality' });
    if (outcome.status !== 'refused') throw new Error('unreachable');
    expect(outcome.reply).toContain('Markham');
    expect(await auditRows('registration_course_bound')).toHaveLength(0);
    expect((await sequenceRow()).courseUrl).toBeNull();
  });

  it('refuses a season more than MAX_BIND_DRIFT_DAYS from the morning it is holding', async () => {
    const sequence = await preparing();

    const outcome = await handleCourseBind(
      db.database,
      { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({ fetchBody: serving(nextSeason()) }),
    );

    expect(outcome).toMatchObject({ status: 'refused', reason: 'different_season' });
    if (outcome.status !== 'refused') throw new Error('unreachable');
    // Both dates, so a parent can see which one Hale thought it was holding.
    expect(outcome.reply).toMatch(/Sep/);
    expect(outcome.reply).toMatch(/Aug/);
    expect(await auditRows('registration_course_bound')).toHaveLength(0);
    expect((await sequenceRow()).courseUrl).toBeNull();
  });

  it('writes nothing when the page cannot be read — kills a bind that stores a URL it never opened', async () => {
    const sequence = await preparing();

    const outcome = await handleCourseBind(
      db.database,
      { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({
        fetchBody: async () => {
          throw new Error('ETIMEDOUT');
        },
      }),
    );

    expect(outcome).toMatchObject({ status: 'refused', reason: 'page_unreadable' });
    expect((await sequenceRow()).courseUrl).toBeNull();
    expect(await auditRows('registration_course_bound')).toHaveLength(0);
  });

  it('declines an already-open course to the coach rather than refusing it', async () => {
    // 06:45 on the resident morning: the page's own clock is fifteen minutes past.
    const now = new Date('2026-08-11T06:45:00-04:00');
    await db.database
      .update(schema.registrationWindows)
      .set({ openAt: new Date('2026-08-20T10:30:00.000Z') })
      .where(eq(schema.registrationWindows.id, windowId));
    const sequence = await preparing(now);

    const outcome = await handleCourseBind(
      db.database,
      { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now },
      deps({ fetchBody: serving(fixture('open-window-open-markham')) }),
    );

    expect(outcome).toEqual({ status: 'declined', reason: 'already_open' });
    expect((await sequenceRow()).courseUrl).toBeNull();
    expect(await auditRows('registration_course_bound')).toHaveLength(0);
  });
});

describe('the bind write', () => {
  it('stores the page’s resident clock and one audit row targeting the inbound message', async () => {
    const sequence = await preparing();

    const outcome = await handleCourseBind(
      db.database,
      { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({ fetchBody: serving(fixture('open-window-open-markham')) }),
    );

    expect(outcome.status).toBe('bound');
    const row = await sequenceRow();
    const sanitized = sanitizeSpotUrl(legoUrl);
    expect(row.courseUrl).toBe(sanitized.ok ? sanitized.url : null);
    expect(row.courseOpensAt).toEqual(RESIDENT_CLOCK);

    const [audit] = await auditRows('registration_course_bound');
    expect(audit).toMatchObject({
      actor: parentUserId,
      targetTable: 'channel_messages',
      targetId: inboundId,
    });
    expect(audit?.after).toMatchObject({
      sequenceId,
      host: 'cityofmarkham.perfectmind.com',
      replaced: false,
      driftMinutes: 0,
    });
    // Never the URL beyond the host, never the class name, never a price.
    expect(JSON.stringify(audit?.after)).not.toContain('widgetId');
    expect(JSON.stringify(audit?.after)).not.toMatch(/LEGO/i);
  });

  /**
   * The page's bytes say `2026-08-11T06:30:00` with no offset, and the only zone that
   * makes that instant is the PORTAL's. Kills `new Date(String(raw))`, which is right
   * only on a host that happens to run Eastern time — every prod region and every
   * laptop outside it stores a clock hours away from the morning.
   */
  it('reads the page’s naive clock in the portal’s zone, not the machine’s', async () => {
    vi.stubEnv('TZ', 'America/Vancouver');
    const sequence = await preparing();
    const stored: Date[] = [];

    await handleCourseBind(
      db.database,
      { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({
        fetchBody: serving(fixture('open-window-open-markham')),
        recordCourseBinding: async (_database, input) => {
          stored.push(input.courseOpensAt);
          return 'bound';
        },
      }),
    );

    expect(stored).toEqual([RESIDENT_CLOCK]);
  });

  it('gives a two-municipality household the public clock, a day after the M1 row', async () => {
    await setArea('L3T');
    const sequence = await preparing();

    await handleCourseBind(
      db.database,
      { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({ fetchBody: serving(fixture('open-window-open-markham')) }),
    );

    expect((await sequenceRow()).courseOpensAt).toEqual(PUBLIC_CLOCK);
    const [audit] = await auditRows('registration_course_bound');
    expect(audit?.after).toMatchObject({ driftMinutes: 1440 });
  });

  it('names the class, the day and time, the price pair, the barcode and the clock', async () => {
    const sequence = await preparing();

    const outcome = await handleCourseBind(
      db.database,
      { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({ fetchBody: serving(fixture('open-window-open-markham')) }),
    );

    if (outcome.status !== 'bound') throw new Error(`expected a bind, got ${outcome.status}`);
    expect(outcome.reply).toContain("Markham's portal");
    expect(outcome.reply).toMatch(/Course [0-9]/);
    expect(outcome.reply).toMatch(/\$\d/);
    expect(outcome.reply).toMatch(/Opens /);
  });

  it('is idempotent: the same link again re-renders the ack and writes no second audit row', async () => {
    const sequence = await preparing();
    const bind = () =>
      handleCourseBind(
        db.database,
        { sequence, rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
        deps({ fetchBody: serving(fixture('open-window-open-markham')) }),
      );

    const first = await bind();
    const second = await bind();

    expect(first.status).toBe('bound');
    expect(second.status).toBe('already_bound');
    if (first.status === 'declined' || second.status === 'declined') throw new Error('declined');
    expect(second.reply).toBe(first.reply);
    expect(await auditRows('registration_course_bound')).toHaveLength(1);
  });

  it('marks a replacement as replaced — kills an ack that says nothing changed', async () => {
    await handleCourseBind(
      db.database,
      { sequence: await preparing(), rawUrl: legoUrl, inboundChannelMessageId: inboundId, now: NOW },
      deps({ fetchBody: serving(fixture('open-window-open-markham')) }),
    );
    // A second course on the same portal whose clock is inside the drift ceiling.
    const outcome = await handleCourseBind(
      db.database,
      {
        sequence: await preparing(),
        rawUrl: chessUrl,
        inboundChannelMessageId: inboundId,
        now: NOW,
      },
      deps({
        fetchBody: serving(
          fixture('open-window-open-markham').replace(
            new RegExp(LEGO, 'g'),
            CHESS,
          ),
        ),
      }),
    );

    expect(outcome.status).toBe('bound');
    const rows = await auditRows('registration_course_bound');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.after as { replaced: boolean }).replaced)).toEqual([false, true]);
  });
});

describe('the readiness writer', () => {
  it('records a YES once, with the inbound message as its target', async () => {
    const sequence = await preparing();

    const outcome = await handleReadinessAnswer(
      db.database,
      {
        sequence,
        ready: true,
        read: 'keyword',
        confidence: null,
        inboundChannelMessageId: inboundId,
        now: NOW,
      },
      deps(),
    );

    expect(outcome.status).toBe('readiness_recorded');
    expect(outcome.reply).toContain('you told me');
    expect((await sequenceRow()).readinessReady).toBe(true);
    const [audit] = await auditRows('registration_readiness_stated');
    expect(audit).toMatchObject({ actor: parentUserId, targetId: inboundId });
    expect(audit?.after).toMatchObject({ sequenceId, ready: true, read: 'keyword' });
  });

  it('answers the identical answer again without a second audit row (guarded UPDATE)', async () => {
    const answer = async () =>
      handleReadinessAnswer(
        db.database,
        {
          sequence: await preparing(),
          ready: true,
          read: 'keyword',
          confidence: null,
          inboundChannelMessageId: inboundId,
          now: NOW,
        },
        deps(),
      );

    const first = await answer();
    const second = await answer();

    expect(first.status).toBe('readiness_recorded');
    expect(second.status).toBe('already_answered');
    expect(second.reply).toBe(first.reply);
    expect(await auditRows('registration_readiness_stated')).toHaveLength(1);
  });

  it('lets a later NO supersede the column and keeps both rows in the trail', async () => {
    await handleReadinessAnswer(
      db.database,
      {
        sequence: await preparing(),
        ready: true,
        read: 'keyword',
        confidence: null,
        inboundChannelMessageId: inboundId,
        now: NOW,
      },
      deps(),
    );
    const outcome = await handleReadinessAnswer(
      db.database,
      {
        sequence: await preparing(),
        ready: false,
        read: 'resolver',
        confidence: 'high',
        inboundChannelMessageId: inboundId,
        now: NOW,
      },
      deps(),
    );

    expect(outcome.status).toBe('readiness_recorded');
    expect((await sequenceRow()).readinessReady).toBe(false);
    expect(await auditRows('registration_readiness_stated')).toHaveLength(2);
    // The NO ack does not re-ask: under the last-word rule an ack that asked again
    // would hold the question open across days of unrelated conversation.
    expect(outcome.reply).not.toContain('?');
  });
});

describe('the readiness question is open only while the ask is Hale’s last word', () => {
  const readinessKey = () => `registration_sequence:${familyId}:${windowId}:readiness`;
  const battlePlanKey = () => `registration_sequence:${familyId}:${windowId}:battle_plan`;
  const ASKED_AT = new Date('2026-08-08T14:00:00.000Z');

  it('is closed with no ask row at all — the vacuous-truth guard', async () => {
    expect(await readinessQuestion(db.database, familyId, NOW)).toBeNull();
  });

  it('opens right after the ask, dated by the ask row', async () => {
    await seedOutbound({ dedupeKey: readinessKey(), createdAt: ASKED_AT });

    const question = await readinessQuestion(db.database, familyId, NOW);

    expect(question).toMatchObject({ id: sequenceId, askedAt: ASKED_AT });
    expect(question?.summary.length).toBeGreaterThan(10);
  });

  it('closes the moment any newer outbound goes to this parent', async () => {
    await seedOutbound({ dedupeKey: readinessKey(), createdAt: ASKED_AT });
    await seedOutbound({
      dedupeKey: null,
      createdAt: new Date(ASKED_AT.getTime() + 3_600_000),
    });

    expect(await readinessQuestion(db.database, familyId, NOW)).toBeNull();
  });

  it('re-opens on the battle plan’s re-ask, and dates itself by the NEWEST ask', async () => {
    const reaskedAt = new Date('2026-08-10T23:00:00.000Z');
    await seedOutbound({ dedupeKey: readinessKey(), createdAt: ASKED_AT });
    await seedOutbound({ dedupeKey: battlePlanKey(), createdAt: reaskedAt });

    expect(await readinessQuestion(db.database, familyId, NOW)).toMatchObject({
      askedAt: reaskedAt,
    });
  });

  it('is closed once the parent has said the setup is done', async () => {
    await seedOutbound({ dedupeKey: readinessKey(), createdAt: ASKED_AT });
    await db.database
      .update(schema.registrationSequences)
      .set({ readinessReady: true })
      .where(eq(schema.registrationSequences.id, sequenceId));

    expect(await readinessQuestion(db.database, familyId, NOW)).toBeNull();
  });

  it('is not opened by an ask that was suppressed and never reached the phone', async () => {
    await seedOutbound({
      dedupeKey: readinessKey(),
      createdAt: ASKED_AT,
      status: 'suppressed_quiet_hours',
    });

    expect(await readinessQuestion(db.database, familyId, NOW)).toBeNull();
  });
});
