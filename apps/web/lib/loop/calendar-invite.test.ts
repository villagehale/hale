import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChannel } from '~/lib/channel/fakes';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import type { Channel, ChannelKind } from '~/lib/channel/types';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { CALENDAR_INVITE_SMS_TEMPLATE_KEY } from '~/lib/loop/templates/calendar-invite/sms';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import type { CalendarVoice } from '~/lib/loop/voice/calendar-invite-voice';
import { eventInviteToken, eventInviteUrl } from './ics-invite';
import { createCalendarInviteSender, emailAskDedupeKey, sendPendingInvite } from './calendar-invite';

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
let email: ReturnType<typeof fakeChannel>;
let sms: ReturnType<typeof fakeChannel>;
let voice: CalendarVoice;

/**
 * The composer, scripted. What the model actually writes is measured against real
 * cached Claude in apps/worker/evals/run-calendar-voice-eval.mjs (rule #8); these
 * tests are about what the fan-out DOES with a draft — including the one that never
 * arrives. The scripted note reproduces the summary and the time the way the
 * containment gate requires, so the strings here are what a gated draft looks like.
 */
function scriptedVoice(over: Partial<CalendarVoice> = {}): CalendarVoice {
  return {
    composeAsk: async () => ({ status: 'composed', text: SCRIPTED_ASK, attempts: 1 }),
    composeNote: async (context) => ({
      status: 'composed',
      subject: `${context.summary} is on your calendar`,
      body: `${context.summary} is set for ${context.when}. The invite is attached.`,
      attempts: 1,
    }),
    ...over,
  };
}

const SCRIPTED_ASK = 'Want this in your real calendar? Text me your email and I will send invites there.';

function channels(): Partial<Record<ChannelKind, Channel>> {
  return { email, sms };
}

function sender(over: Partial<CalendarVoice> = {}) {
  return createCalendarInviteSender(db.database, {
    channels: channels(),
    renderer: loopTemplateRenderer,
    voice: Object.keys(over).length > 0 ? scriptedVoice(over) : voice,
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

async function addCoParent(familyId: string, address: string | null): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: address, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('addCoParent: no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
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

function sentEmail() {
  const call = email.calls[0];
  if (!call || call.rendered.kind !== 'email') throw new Error('no email was sent');
  return call.rendered;
}

function attachedIcs(): string {
  const attachment = sentEmail().attachments?.[0];
  if (!attachment) throw new Error('the email carried no attachment');
  return Buffer.from(attachment.content, 'base64').toString('utf8');
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
  email = fakeChannel('email', { status: 'sent', providerMessageId: 'resend-1' });
  sms = fakeChannel('sms', { status: 'sent', providerMessageId: 'twilio-1' });
  voice = scriptedVoice();
  vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsubscribe-secret');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('DATABASE_URL', 'postgres://pglite');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

describe('the invite a placement sends', () => {
  it('emails every parent with an address, through the dispatch, with the ICS attached', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const familyEventId = await seedPlacement(familyId);

    const report = await sender().send({
      familyId,
      familyEventId,
      method: 'REQUEST',
    });

    expect(report).toEqual({
      status: 'reported',
      parents: [{ parentUserId, channel: 'email', outcome: 'sent' }],
      ask: 'not_needed',
    });

    const rendered = sentEmail();
    expect(rendered.subject).toContain('Swim class');
    expect(rendered.attachments?.[0]?.contentType).toBe(
      'text/calendar; charset=utf-8; method=REQUEST',
    );
    expect(attachedIcs()).toContain('METHOD:REQUEST');
    expect(attachedIcs()).toContain(`UID:${familyEventId}@hale`);
    // Nothing was texted: the invite is pinned to the email leg.
    expect(sms.calls).toHaveLength(0);
  });

  it('writes the ledger row and the audit row the send owes (rules #6 + the A2 ledger)', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const familyEventId = await seedPlacement(familyId);

    await sender().send({ familyId, familyEventId, method: 'REQUEST' });

    const rows = await ledger(familyId, 'calendar_invite');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', channel: 'email' });
    // Outbound rows never store the rendered body (rule #1).
    expect(rows[0]?.body).toBeNull();

    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, 'channel_sent')),
      );
    expect(audits).toHaveLength(1);

    // The CASL sub-ledger records the address the invite actually went to.
    const sends = await db.database
      .select({ emailType: schema.emailSends.emailType })
      .from(schema.emailSends)
      .where(eq(schema.emailSends.userId, parentUserId));
    expect(sends).toEqual([{ emailType: 'approval' }]);
  });

  it('re-driving the same placement sends nothing twice (already_sent)', async () => {
    const { familyId } = await seedFamily(db.database);
    const familyEventId = await seedPlacement(familyId);
    const invites = sender();

    await invites.send({ familyId, familyEventId, method: 'REQUEST' });
    const second = await invites.send({ familyId, familyEventId, method: 'REQUEST' });

    expect(second).toMatchObject({
      parents: [expect.objectContaining({ outcome: 'already_sent' })],
    });
    expect(email.calls).toHaveLength(1);
  });

  it('sends the iTIP CANCEL for a cancelled placement, and asks nobody for an address', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await clearEmail(parentUserId);
    const familyEventId = await seedPlacement(familyId);
    await db.database
      .update(schema.familyEvents)
      .set({ deletedAt: NOON })
      .where(eq(schema.familyEvents.id, familyEventId));

    const report = await sender().send({
      familyId,
      familyEventId,
      method: 'CANCEL',
    });

    // Nothing to add to a calendar means nothing to ask about.
    expect(report).toMatchObject({ ask: 'not_needed' });
    expect(await ledger(familyId, 'calendar_email_ask')).toHaveLength(0);
  });

  it('names a teen’s event generically in the SUBJECT as well as the attachment (rule #1)', async () => {
    const { familyId } = await seedFamily(db.database);
    const teenId = await seedChild(db.database, familyId, 'Maya', 14 * 12);
    const familyEventId = await seedPlacement(familyId, {
      childId: teenId,
      title: 'Maya therapy intake',
    });

    await sender().send({ familyId, familyEventId, method: 'REQUEST' });

    const rendered = sentEmail();
    expect(rendered.subject).not.toContain('Maya');
    expect(rendered.subject).not.toContain('therapy');
    expect(rendered.subject).toContain('an appointment');
    expect(attachedIcs()).toContain('SUMMARY:an appointment');
    expect(attachedIcs()).not.toContain('Maya');
  });

  it('names a parent reachable on neither channel rather than dropping them silently', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const coParentId = await addCoParent(familyId, null);
    const familyEventId = await seedPlacement(familyId);

    const report = await sender().send({
      familyId,
      familyEventId,
      method: 'REQUEST',
    });

    expect(report).toMatchObject({
      parents: [
        { parentUserId, channel: 'email', outcome: 'sent' },
        // No address AND no live SMS channel — named, never folded into the email
        // leg's silence.
        { parentUserId: coParentId, channel: 'sms', outcome: 'no_channel' },
      ],
      // One parent CAN be emailed, so the family is not asked for an address.
      ask: 'not_needed',
    });
  });

  it('names an unconfigured email channel as not_configured, not as a failure to send', async () => {
    const { familyId } = await seedFamily(db.database);
    const familyEventId = await seedPlacement(familyId);
    email = fakeChannel('email', { status: 'skipped', reason: 'not_configured' });

    const report = await sender().send({
      familyId,
      familyEventId,
      method: 'REQUEST',
    });

    expect(report).toMatchObject({
      parents: [expect.objectContaining({ outcome: 'not_configured', reason: 'not_configured' })],
    });
  });

  it('names a provider refusal as send_failed', async () => {
    const { familyId } = await seedFamily(db.database);
    const familyEventId = await seedPlacement(familyId);
    email = fakeChannel('email', {
      status: 'error',
      transient: false,
      code: 'invalid_recipient',
      message: 'bad address',
    });

    const report = await sender().send({
      familyId,
      familyEventId,
      method: 'REQUEST',
    });

    expect(report).toMatchObject({
      parents: [expect.objectContaining({ outcome: 'send_failed', reason: 'invalid_recipient' })],
    });
  });
});

describe('a composer that cannot produce a sendable draft', () => {
  it('sends no invite and names compose_deferred — never a preset body', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const familyEventId = await seedPlacement(familyId);

    const report = await sender({
      composeNote: async () => ({ status: 'deferred', reason: 'carried a link', attempts: 3 }),
    }).send({ familyId, familyEventId, method: 'REQUEST' });

    expect(report).toMatchObject({
      parents: [
        { parentUserId, channel: 'email', outcome: 'compose_deferred', reason: 'carried a link' },
      ],
    });
    expect(email.calls).toHaveLength(0);
    expect(await ledger(familyId, 'calendar_invite')).toHaveLength(0);
  });

  it('leaves the once-ever ask claim UNCONSUMED, so the next placement asks again', async () => {
    const seeded = await seedFamily(db.database);
    await clearEmail(seeded.parentUserId);

    const deferred = await sender({
      composeAsk: async () => ({ status: 'deferred', reason: 'the message had 2 question marks', attempts: 3 }),
    }).send({
      familyId: seeded.familyId,
      familyEventId: await seedPlacement(seeded.familyId),
      method: 'REQUEST',
    });
    expect(deferred).toMatchObject({ ask: 'compose_deferred' });
    expect(sms.calls).toHaveLength(0);

    // The claim row records the attempt but holds no key...
    const afterDefer = await ledger(seeded.familyId, 'calendar_email_ask');
    expect(afterDefer).toHaveLength(1);
    expect(afterDefer[0]).toMatchObject({ status: 'failed', errorCode: 'compose_deferred' });
    expect(afterDefer[0]?.dedupeKey).toBeNull();

    // ...so the next placement claims again rather than reading the family as asked.
    const second = await sender().send({
      familyId: seeded.familyId,
      familyEventId: await seedPlacement(seeded.familyId, { title: 'Library story time' }),
      method: 'REQUEST',
    });
    expect(second).not.toMatchObject({ ask: 'already_asked' });
    expect(await ledger(seeded.familyId, 'calendar_email_ask')).toHaveLength(2);
  });
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

  it('texts the emailless parent one link, and asks nobody for an address', async () => {
    const { familyId, parentUserId } = await textOnlyFamily();
    const familyEventId = await seedPlacement(familyId);

    const report = await sender().send({ familyId, familyEventId, method: 'REQUEST' });

    expect(report).toEqual({
      status: 'reported',
      parents: [{ parentUserId, channel: 'sms', outcome: 'sent' }],
      // The round-trip is gone: there is nothing left to collect an address FOR.
      ask: 'not_needed',
    });
    expect(sentText()).toContain('Swim class');
    expect(sentText()).toContain('Tap to put it on your phone');
    expect(sentText()).toContain('https://app.villagehale.com/api/ics/event/');
    expect(await ledger(familyId, 'calendar_email_ask')).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
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
    // Born 'queued': Twilio took it, the delivery receipt has not landed yet.
    expect(rows[0]).toMatchObject({ status: 'queued', channel: 'sms' });
    expect(rows[0]?.body).toBeNull();
  });

  it('gives a family with one of each BOTH the attachment and the link', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const coParentId = await addCoParent(familyId, null);
    await enrollSms(familyId, coParentId);
    const familyEventId = await seedPlacement(familyId);

    const report = await sender().send({ familyId, familyEventId, method: 'REQUEST' });

    expect(report).toMatchObject({
      parents: [
        { parentUserId, channel: 'email', outcome: 'sent' },
        { parentUserId: coParentId, channel: 'sms', outcome: 'sent' },
      ],
      ask: 'not_needed',
    });
    expect(attachedIcs()).toContain(`UID:${familyEventId}@hale`);
    expect(sentText()).toContain('Tap to put it on your phone');
  });

  it('names no_channel for a parent with neither an address nor a live SMS channel', async () => {
    // No parent_channels row at all — the live state a STOP leaves behind.
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
});

describe('the one-time ask for an address', () => {
  it('asks a STOPPED family nothing, and says so', async () => {
    // No parent_channels row at all — the same live state a STOP leaves behind
    // (the row is revoked, so the consent read finds nothing enrolled).
    const seeded = await seedFamily(db.database);
    await clearEmail(seeded.parentUserId);
    const familyEventId = await seedPlacement(seeded.familyId);

    const report = await sender().send({
      familyId: seeded.familyId,
      familyEventId,
      method: 'REQUEST',
    });

    expect(report).toMatchObject({ ask: 'suppressed' });
    expect(sms.calls).toHaveLength(0);
    const rows = await ledger(seeded.familyId, 'calendar_email_ask');
    expect(rows[0]?.status).toBe('suppressed_consent');
    // A suppression gives the key back: the family was never actually asked.
    expect(rows[0]?.dedupeKey).toBeNull();
  });

  it('is not spent on a family that got the link instead', async () => {
    const seeded = await seedFamily(db.database);
    await clearEmail(seeded.parentUserId);
    await enrollSms(seeded.familyId, seeded.parentUserId);

    const report = await sender().send({
      familyId: seeded.familyId,
      familyEventId: await seedPlacement(seeded.familyId),
      method: 'REQUEST',
    });

    expect(report).toMatchObject({ ask: 'not_needed' });
    // The once-ever key is unspent, so nothing about this family is now un-askable.
    const rows = await ledger(seeded.familyId, 'calendar_email_ask');
    expect(rows).toHaveLength(0);
    expect(emailAskDedupeKey(seeded.familyId)).toContain(seeded.familyId);
  });
});

describe('sendPendingInvite — the catch-up after an address arrives', () => {
  it('sends the most recent standing placement to the parent who just gave an address', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedPlacement(familyId, { title: 'Swim class' });
    await seedPlacement(familyId, {
      title: 'Library story time',
      startsAt: new Date('2026-07-24T14:30:00.000Z'),
    });

    const outcome = await sendPendingInvite(
      db.database,
      { familyId, parentUserId },
      { channels: channels(), renderer: loopTemplateRenderer, voice, now: () => NOON },
    );

    expect(outcome).toMatchObject({ outcome: 'sent' });
    expect(sentEmail().subject).toContain('Library story time');
  });

  it('says nothing_pending when the family has no standing placement', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);

    const outcome = await sendPendingInvite(
      db.database,
      { familyId, parentUserId },
      { channels: channels(), renderer: loopTemplateRenderer, voice, now: () => NOON },
    );

    expect(outcome).toEqual({ outcome: 'nothing_pending' });
    expect(email.calls).toHaveLength(0);
  });
});
