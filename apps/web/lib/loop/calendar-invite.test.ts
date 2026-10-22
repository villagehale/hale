import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChannel } from '~/lib/channel/fakes';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import type { Channel, ChannelKind } from '~/lib/channel/types';
import { encryptString } from '~/lib/crypto/string-cipher';
import { CALENDAR_INVITE_SMS_TEMPLATE_KEY } from '~/lib/loop/templates/calendar-invite/sms';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import type {
  CalendarCancelOutcome,
  CalendarCancelRequest,
} from '~/lib/loop/voice/calendar-cancel-voice';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { createCalendarInviteSender } from './calendar-invite';
import { eventInviteToken, eventInviteUrl } from './ics-invite';

/**
 * The per-event ICS route resolves its own db handle. The link round-trip below drives
 * the REAL route handler against the SAME pglite database the fan-out just wrote to, so
 * "the text carries a link that works" is proven by the thing that serves it rather than
 * by a second copy of the token maths.
 */
const routeDb = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('~/lib/db', () => ({ db: () => routeDb.current }));

/**
 * VIL-249 · M13 — the invite a placement actually sends, against a REAL Postgres
 * (pglite + the production migrations) and FAKE channels. The database is real
 * because the two things most likely to be wrong live in SQL: the one-ask-ever claim
 * is a partial unique index, and "which parents get this" is a join. The channels are
 * fake because nothing here may reach a provider.
 *
 * What each case pins is the same invariant from a different side: a placement that
 * cannot be emailed says so in words the executor writes down, and never by omission.
 */

const NOON = new Date('2026-07-22T16:00:00.000Z'); // 12:00 in Toronto — outside quiet hours
const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+16475550123';

let db: TestDb;
let sms: ReturnType<typeof fakeChannel>;
/** What the cancellation composer was handed, and what it answers. */
let cancelCalls: CalendarCancelRequest[];
let cancelOutcome: CalendarCancelOutcome;

function channels(): Partial<Record<ChannelKind, Channel>> {
  return { sms };
}

function sender() {
  return createCalendarInviteSender(db.database, {
    channels: channels(),
    renderer: loopTemplateRenderer,
    cancelVoice: {
      compose: async (request) => {
        cancelCalls.push(request);
        return cancelOutcome;
      },
    },
    now: () => NOON,
  });
}

/** A placed event on the family's calendar — what an approved calendar_add writes. */
async function seedPlacement(
  familyId: string,
  overrides: { childId?: string; sensitive?: boolean; title?: string; startsAt?: Date } = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      childId: overrides.childId ?? null,
      title: overrides.title ?? 'Swim class',
      startsAt: overrides.startsAt ?? new Date('2026-07-23T14:30:00.000Z'),
      endsAt: new Date('2026-07-23T15:15:00.000Z'),
      location: 'Community pool',
      source: 'placement',
      sensitive: overrides.sensitive ?? false,
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('seedPlacement: no row');
  return row.id;
}

/** An enrolled, verified SMS channel — what makes the dispatch's consent gate open. */
async function enrollSms(familyId: string, userId: string): Promise<void> {
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: `hash-${userId}`,
    verifiedAt: new Date('2026-07-01T00:00:00.000Z'),
  });
}

async function clearEmail(userId: string): Promise<void> {
  await db.database.update(schema.users).set({ email: null }).where(eq(schema.users.id, userId));
}

async function ledger(familyId: string, templateKey: string) {
  return db.database
    .select({
      status: schema.channelMessages.status,
      channel: schema.channelMessages.channel,
      dedupeKey: schema.channelMessages.dedupeKey,
      errorCode: schema.channelMessages.errorCode,
      body: schema.channelMessages.body,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, templateKey),
      ),
    );
}

function sentText(index = 0): string {
  const call = sms.calls[index];
  if (!call || call.rendered.kind !== 'sms') throw new Error('no text was sent');
  return call.rendered.text;
}

/** The link out of a body that ends with it — the shape the copy guarantees. */
function linkIn(text: string): string {
  const match = text.match(/https:\/\/\S+$/);
  if (!match) throw new Error(`no link in: ${text}`);
  return match[0];
}

/** The family's own feed secret, as the first minted link wrote it. */
async function feedToken(familyId: string): Promise<string> {
  const [row] = await db.database
    .select({ token: schema.families.icsShareToken })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  if (!row?.token) throw new Error('no feed token was minted');
  return row.token;
}

/** The real route handler, against this test's database. */
async function fetchIcs(url: string): Promise<Response> {
  const { GET } = await import('~/app/api/ics/event/[token]/route');
  const token = url.slice(url.lastIndexOf('/') + 1);
  return GET(new Request(url), { params: Promise.resolve({ token }) });
}

beforeEach(async () => {
  db = await createTestDb();
  routeDb.current = db.database;
  sms = fakeChannel('sms', { status: 'sent', providerMessageId: 'linq-1' });
  cancelCalls = [];
  cancelOutcome = {
    status: 'composed',
    body: 'Swim class on Thu, Jul 23 at 10:30 AM is cancelled - you can take it off your calendar.',
  };
  vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsubscribe-secret');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://pglite');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

/**
 * A yes over text becomes a tap-to-add link, not just "Approved".
 *
 * The invite used to exist on ONE channel — an email attachment — so a family that had
 * only ever texted Hale (every SMS-intake family: users.email is null) got a placement
 * on Hale's own calendar and nothing on their phone. The primitive that closes it was
 * already deployed and had zero callers: a per-event HMAC link served unauthenticated
 * by /api/ics/event/:token. These cases are the wiring, and the link is round-tripped
 * through the REAL route rather than re-derived, because a link that mints but does not
 * serve is the failure this whole leg exists to avoid.
 */
describe('the tap-to-add link a text-only family gets', () => {
  async function textOnlyFamily() {
    const seeded = await seedFamily(db.database);
    await clearEmail(seeded.parentUserId);
    await enrollSms(seeded.familyId, seeded.parentUserId);
    return seeded;
  }

  it('texts the parent one link', async () => {
    const { familyId, parentUserId } = await textOnlyFamily();
    const familyEventId = await seedPlacement(familyId);

    const report = await sender().send({ familyId, familyEventId, method: 'REQUEST' });

    expect(report).toEqual({
      status: 'reported',
      parents: [{ parentUserId, channel: 'sms', outcome: 'sent' }],
    });
    expect(sentText()).toContain('Swim class');
    expect(sentText()).toContain('Tap to put it on your phone');
    expect(sentText()).toContain('https://app.villagehale.com/api/ics/event/');
  });

  it('serves THAT event as a calendar file through the real route', async () => {
    const { familyId } = await textOnlyFamily();
    const familyEventId = await seedPlacement(familyId);

    await sender().send({ familyId, familyEventId, method: 'REQUEST' });
    const res = await fetchIcs(linkIn(sentText()));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    // iOS opens an attachment in Calendar; an inline body renders as text.
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="invite.ics"');
    const ics = await res.text();
    expect(ics).toContain(`UID:${familyEventId}@hale`);
    expect(ics).toContain('BEGIN:VEVENT');
  });

  it('writes the ledger row the text owes, on the sms leg', async () => {
    const { familyId } = await textOnlyFamily();

    await sender().send({
      familyId,
      familyEventId: await seedPlacement(familyId),
      method: 'REQUEST',
    });

    const rows = await ledger(familyId, CALENDAR_INVITE_SMS_TEMPLATE_KEY);
    expect(rows).toHaveLength(1);
    // Born 'queued': the provider took it, the delivery receipt has not landed yet.
    expect(rows[0]).toMatchObject({ status: 'queued', channel: 'sms' });
    expect(rows[0]?.body).toBeNull();
  });

  /**
   * WHAT THE MINT SAYS IT DID. The link is signed with the family's `ics_share_token`,
   * so the first one ever sent creates that secret — and the secret's mint is also what
   * a parent turning on the whole-calendar SUBSCRIPTION would write. They are not the
   * same disclosure: a per-event link is a one-way HMAC over the secret and reveals
   * nothing of the feed. A trail that said "you turned on your calendar subscription"
   * would be telling a family, on the surface whose entire job is to be true, about a
   * feed URL nobody was ever handed (rule #1 + rule #6).
   */
  it('records the mint as the link it was, not as a subscription nobody turned on', async () => {
    const { familyId } = await textOnlyFamily();

    await sender().send({
      familyId,
      familyEventId: await seedPlacement(familyId),
      method: 'REQUEST',
    });

    const rows = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.targetTable, 'families')),
      );
    expect(rows).toEqual([{ actionTaken: 'ics_event_link_minted' }]);
  });

  it('texts a parent who has an email address the same link — no email leg exists', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await enrollSms(familyId, parentUserId);
    const familyEventId = await seedPlacement(familyId);

    const report = await sender().send({ familyId, familyEventId, method: 'REQUEST' });

    expect(report).toEqual({
      status: 'reported',
      parents: [{ parentUserId, channel: 'sms', outcome: 'sent' }],
    });
    expect(sentText()).toContain('Tap to put it on your phone');
  });

  /** What an approved calendar_cancel leaves behind: the row soft-deleted. */
  async function softDelete(familyEventId: string): Promise<void> {
    await db.database
      .update(schema.familyEvents)
      .set({ deletedAt: NOON })
      .where(eq(schema.familyEvents.id, familyEventId));
  }

  it('texts a parent who got the link that the event is cancelled, in the composed words', async () => {
    const { familyId, parentUserId } = await textOnlyFamily();
    const familyEventId = await seedPlacement(familyId);
    await sender().send({ familyId, familyEventId, method: 'REQUEST' });
    await softDelete(familyEventId);

    const report = await sender().send({ familyId, familyEventId, method: 'CANCEL' });

    expect(report).toEqual({
      status: 'reported',
      parents: [{ parentUserId, channel: 'sms', outcome: 'sent' }],
    });
    expect(cancelCalls).toEqual([{ summary: 'Swim class', when: 'Thu, Jul 23 at 10:30 AM' }]);
    expect(sentText(1)).toBe(
      'Swim class on Thu, Jul 23 at 10:30 AM is cancelled - you can take it off your calendar.',
    );
  });

  it('sends the plain receipt when the composer defers', async () => {
    const { familyId } = await textOnlyFamily();
    const familyEventId = await seedPlacement(familyId);
    await sender().send({ familyId, familyEventId, method: 'REQUEST' });
    await softDelete(familyEventId);
    cancelOutcome = { status: 'deferred', reason: 'model_failed' };

    await sender().send({ familyId, familyEventId, method: 'CANCEL' });

    expect(sentText(1)).toBe(
      'Cancelled - Swim class, Thu, Jul 23 at 10:30 AM. You can take it off your calendar.',
    );
  });

  it('names never_linked for a parent who was never texted the link, and texts nothing', async () => {
    const { familyId, parentUserId } = await textOnlyFamily();
    const familyEventId = await seedPlacement(familyId);

    const report = await sender().send({ familyId, familyEventId, method: 'CANCEL' });

    expect(report).toEqual({
      status: 'reported',
      parents: [{ parentUserId, channel: 'sms', outcome: 'never_linked' }],
    });
    expect(sms.calls).toHaveLength(0);
    expect(cancelCalls).toEqual([]);
  });

  it('names no_channel for a parent with neither an address nor a live SMS channel', async () => {
    // No parent_channels row at all — a parent who never enrolled.
    const { familyId, parentUserId } = await seedFamily(db.database);
    await clearEmail(parentUserId);

    const report = await sender().send({
      familyId,
      familyEventId: await seedPlacement(familyId),
      method: 'REQUEST',
    });

    expect(report).toMatchObject({
      parents: [{ parentUserId, channel: 'sms', outcome: 'no_channel' }],
    });
    expect(sms.calls).toHaveLength(0);
  });

  /**
   * The state a STOP actually leaves, which is NOT the one above: the parent_channels
   * row stays exactly where it is and takes a `revoked_at`. The consent read excludes
   * it with a different SQL predicate than "no row", so the two arrive at the same
   * answer down two different paths, and a family that texted STOP is the likelier of
   * the two to have a placement in flight.
   */
  it('names no_channel for a parent whose SMS channel was revoked by STOP', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await clearEmail(parentUserId);
    await enrollSms(familyId, parentUserId);
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: new Date('2026-07-10T00:00:00.000Z') })
      .where(eq(schema.parentChannels.userId, parentUserId));

    const report = await sender().send({
      familyId,
      familyEventId: await seedPlacement(familyId),
      method: 'REQUEST',
    });

    expect(report).toMatchObject({
      parents: [{ parentUserId, channel: 'sms', outcome: 'no_channel' }],
    });
    expect(sms.calls).toHaveLength(0);
  });

  it('re-driving the same placement texts nothing twice', async () => {
    const { familyId } = await textOnlyFamily();
    const familyEventId = await seedPlacement(familyId);
    const invites = sender();

    await invites.send({ familyId, familyEventId, method: 'REQUEST' });
    const second = await invites.send({ familyId, familyEventId, method: 'REQUEST' });

    expect(second).toMatchObject({
      parents: [expect.objectContaining({ channel: 'sms', outcome: 'already_sent' })],
    });
    expect(sms.calls).toHaveLength(1);
  });

  it('will not serve family A an event of family B, signed with A\u2019s own feed secret', async () => {
    const a = await textOnlyFamily();
    const b = await textOnlyFamily();
    const eventB = await seedPlacement(b.familyId, { title: 'Library story time' });

    await sender().send({
      familyId: a.familyId,
      familyEventId: await seedPlacement(a.familyId),
      method: 'REQUEST',
    });
    await sender().send({ familyId: b.familyId, familyEventId: eventB, method: 'REQUEST' });

    // The real cross-tenant attempt, not a garbage string: family A holds its OWN feed
    // secret (the text it just got was minted off it) and signs family B's event id
    // with it. The read keys on the event's own family, so the signature is checked
    // against B's secret and never A's.
    const forged = eventInviteUrl(eventInviteToken(eventB, await feedToken(a.familyId)));

    // Positive control: family B's own link resolves, so the 404 below is the signature
    // and not a broken fixture.
    expect((await fetchIcs(linkIn(sentText(1)))).status).toBe(200);
    expect((await fetchIcs(forged)).status).toBe(404);
  });

  it('keeps a teen’s event generic in the text as well (rule #1)', async () => {
    const { familyId } = await textOnlyFamily();
    const teenId = await seedChild(db.database, familyId, 'Maya', 14 * 12);
    const familyEventId = await seedPlacement(familyId, {
      childId: teenId,
      title: 'Maya therapy intake',
    });

    await sender().send({ familyId, familyEventId, method: 'REQUEST' });

    expect(sentText()).not.toContain('Maya');
    expect(sentText()).not.toContain('therapy');
    expect(sentText()).toContain('an appointment');
  });

  /**
   * The budget, measured on a REAL token: a uuid, a dot, and a 43-character base64url
   * HMAC is 80 characters of link before a word is written. Two segments is the
   * ceiling every deterministic Hale text is held to, and a third would be a 50% bill
   * increase on every placement a texting family approves.
   */
  it('fits two GSM-7 segments with the real link inside it', async () => {
    const { familyId } = await textOnlyFamily();

    await sender().send({
      familyId,
      familyEventId: await seedPlacement(familyId, { title: 'Saturday swim lessons' }),
      method: 'REQUEST',
    });

    const body = sentText();
    expect(linkIn(body)).toHaveLength(
      'https://app.villagehale.com/api/ics/event/'.length + 36 + 1 + 43,
    );
    expect({ encoding: smsEncoding(body), segments: smsSegments(body) }).toEqual({
      encoding: 'gsm7',
      segments: 2,
    });
  });

  /**
   * The same budget at the dial that NAMES the child — the branch the childless fixture
   * above can never reach. `eventDescriptor` attributes a title to its child with an EM
   * DASH ("Maya — Swim class"), one character outside GSM-7, and a single one of those
   * re-encodes the entire body as UCS-2: 67 units per part instead of 153, so the same
   * text bills four segments instead of two. The file scan in sms-copy-encoding.test.ts
   * cannot see it, because the character arrives at runtime from a family_events row.
   */
  it('still fits two GSM-7 segments at the dial that names the child', async () => {
    const { familyId, parentUserId } = await textOnlyFamily();
    await db.database
      .insert(schema.loopPrefs)
      .values({ userId: parentUserId, childNameLevel: 'first_name' });
    const childId = await seedChild(db.database, familyId, 'Maya', 36);

    await sender().send({
      familyId,
      familyEventId: await seedPlacement(familyId, {
        childId,
        title: 'Preschool swim lessons - Level 2 (Saturdays)',
      }),
      method: 'REQUEST',
    });

    const body = sentText();
    // Folded, not dropped: the parent turned names ON, so the name still arrives.
    expect(body).toContain('Maya - Preschool swim lessons - Level 2 (Saturdays)');
    expect({ encoding: smsEncoding(body), segments: smsSegments(body) }).toEqual({
      encoding: 'gsm7',
      segments: 2,
    });
  });
});
