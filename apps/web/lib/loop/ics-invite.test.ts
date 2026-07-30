import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { ResendTransport } from '~/lib/channel/resend-transport';
import {
  type InviteEventRow,
  eventInviteToken,
  eventInviteUrl,
  icsSequence,
  loadEventInvite,
  mintEventInviteLink,
  sendEventInvite,
  toInviteEvent,
} from './ics-invite.js';

/**
 * VIL-249 · M13 — the per-event invite seam. Three properties matter and are asserted
 * here against fakes (no DB, no provider): the redaction is the SAME outbound treatment
 * the reminder channels apply (teen age gate + sensitive genericization + the parent's
 * name dial), the token is a one-way handle that dies with the family's feed token, and
 * the email leg carries the invite as a text/calendar attachment.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const CHILD_ID = 'bbbbbbbb-3333-4333-8333-333333333333';
const PARENT_ID = 'cccccccc-4444-4444-8444-444444444444';
const SHARE_TOKEN = 'family_feed_share_token_value';
const NOW = new Date('2026-07-21T12:00:00.000Z');
/** 14 years old at NOW — over the 13y teen boundary (deriveStage). */
const TEEN_DOB = '2012-01-04';
/** 7 years old at NOW — a 'child', below the teen boundary. */
const CHILD_DOB = '2019-01-04';

function row(overrides: Partial<InviteEventRow> = {}): InviteEventRow {
  return {
    id: EVENT_ID,
    familyId: FAMILY_ID,
    title: 'Swim class',
    startsAt: new Date('2026-07-22T14:30:00.000Z'),
    endsAt: new Date('2026-07-22T15:30:00.000Z'),
    location: 'Community pool',
    sensitive: false,
    deletedAt: null,
    childId: CHILD_ID,
    childName: 'Maya',
    childDob: CHILD_DOB,
    childGender: 'girl',
    icsShareToken: SHARE_TOKEN,
    ...overrides,
  };
}

/** A query builder that is itself the resolved rows, so any chain shape —
 * `.leftJoin().where().limit()` or a bare `.where()` — awaits to the same result. */
type QueryChain = Promise<unknown[]> & {
  leftJoin: () => QueryChain;
  innerJoin: () => QueryChain;
  where: () => QueryChain;
  limit: () => QueryChain;
};

function queryChain(rows: unknown[]): QueryChain {
  const node = Promise.resolve(rows) as QueryChain;
  node.leftJoin = () => node;
  node.innerJoin = () => node;
  node.where = () => node;
  node.limit = () => node;
  return node;
}

/**
 * A Database fake that dispatches on the TABLE passed to `.from()` (identity against the
 * real schema objects), so it is insensitive to the order the reads happen in.
 */
function fakeDb(tables: {
  events?: unknown[];
  audit?: Array<{ value: number }>;
  prefs?: unknown[];
  families?: Array<{ token: string | null }>;
}) {
  const from = vi.fn((table: unknown) => {
    if (table === schema.familyEvents) return queryChain(tables.events ?? []);
    if (table === schema.auditLog) return queryChain(tables.audit ?? [{ value: 0 }]);
    if (table === schema.loopPrefs) return queryChain(tables.prefs ?? []);
    if (table === schema.families) return queryChain(tables.families ?? []);
    throw new Error('fakeDb: unexpected table read');
  });
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, select, from };
}

function fakeTransport(result: { id: string | null; error: { name: string; message: string } | null }) {
  const send = vi.fn<ResendTransport['send']>(async () => result);
  return { transport: { send } as ResendTransport, send };
}

type FakeSend = ReturnType<typeof fakeTransport>['send'];

/** The one message the fake transport was handed. */
function sentMessage(send: FakeSend) {
  const msg = send.mock.calls[0]?.[0];
  if (!msg) throw new Error('the transport was never called');
  return msg;
}

/** Decode the base64 attachment content back to the raw ICS text. */
function attachedIcs(send: FakeSend): string {
  const attachment = sentMessage(send).attachments?.[0];
  if (!attachment) throw new Error('no attachment on the sent message');
  return Buffer.from(attachment.content, 'base64').toString('utf8');
}

describe('toInviteEvent — the invite carries the channel’s own redaction (rule #1)', () => {
  it('genericizes a TEEN child’s event and drops its location and description, even at first_name', () => {
    const invite = toInviteEvent(
      row({ childDob: TEEN_DOB }),
      { level: 'first_name', note: 'Added from your week plan.', sequence: 0 },
      NOW,
    );

    expect(invite.summary).toBe('an appointment');
    expect(invite.summary).not.toContain('Maya');
    expect(invite.summary).not.toContain('Swim');
    expect(invite.location).toBeNull();
    expect(invite.description).toBeNull();
  });

  it('genericizes a SENSITIVE-flagged event for a non-teen child and drops its location and description', () => {
    const invite = toInviteEvent(
      row({ sensitive: true, title: 'Maya — asthma follow-up', location: 'Sick Kids' }),
      { level: 'first_name', note: 'Added from your week plan.', sequence: 0 },
      NOW,
    );

    expect(invite.summary).toBe('an appointment');
    expect(invite.summary).not.toContain('asthma');
    expect(invite.location).toBeNull();
    expect(invite.description).toBeNull();
  });

  it('keeps the first name, location and description for a non-teen, non-sensitive event at first_name', () => {
    const invite = toInviteEvent(
      row(),
      { level: 'first_name', note: 'Added from your week plan.', sequence: 2 },
      NOW,
    );

    expect(invite.summary).toBe('Maya — Swim class');
    expect(invite.location).toBe('Community pool');
    expect(invite.description).toBe('Added from your week plan.');
    expect(invite.id).toBe(EVENT_ID);
    expect(invite.sequence).toBe(2);
  });

  it('drops to the relation at the parent’s ‘relation’ dial without touching the teen floor', () => {
    const invite = toInviteEvent(row(), { level: 'relation', note: null, sequence: 0 }, NOW);
    expect(invite.summary).toBe('your daughter — Swim class');
  });
});

describe('eventInviteToken — a one-way handle that dies with the family feed token', () => {
  it('is deterministic per (event, family token) and never embeds the family feed token', () => {
    const token = eventInviteToken(EVENT_ID, SHARE_TOKEN);

    expect(eventInviteToken(EVENT_ID, SHARE_TOKEN)).toBe(token);
    expect(token.startsWith(`${EVENT_ID}.`)).toBe(true);
    expect(token).not.toContain(SHARE_TOKEN);
  });

  it('differs for another event and for a rotated family token', () => {
    const token = eventInviteToken(EVENT_ID, SHARE_TOKEN);
    expect(eventInviteToken(CHILD_ID, SHARE_TOKEN)).not.toBe(token);
    expect(eventInviteToken(EVENT_ID, 'rotated_token_value')).not.toBe(token);
  });
});

describe('eventInviteUrl — the app domain, never the marketing domain', () => {
  it('builds the absolute link on the app base URL', () => {
    const url = eventInviteUrl(eventInviteToken(EVENT_ID, SHARE_TOKEN));
    expect(url).toBe(`https://app.villagehale.com/api/ics/event/${eventInviteToken(EVENT_ID, SHARE_TOKEN)}`);
  });

  it('mints the SMS leg’s link off the family’s existing feed token, resolvable by the same route', async () => {
    const { db } = fakeDb({ families: [{ token: SHARE_TOKEN }] });

    const link = await mintEventInviteLink(db, FAMILY_ID, EVENT_ID);

    expect(link).toBe(eventInviteUrl(eventInviteToken(EVENT_ID, SHARE_TOKEN)));
    // The link the SMS carries is exactly what the tokened read accepts.
    const token = link.slice(link.lastIndexOf('/') + 1);
    const { db: readDb } = fakeDb({ events: [row()] });
    expect(await loadEventInvite(readDb, token, NOW)).toContain(`UID:${EVENT_ID}@hale`);
  });
});

describe('loadEventInvite — the tokened single-event read', () => {
  const validToken = () => eventInviteToken(EVENT_ID, SHARE_TOKEN);

  it('serves a downloadable PUBLISH file — addressed to nobody, so it names no ATTENDEE', async () => {
    const { db } = fakeDb({ events: [row()], audit: [{ value: 1 }] });

    const ics = await loadEventInvite(db, validToken(), NOW);

    expect(ics).not.toBeNull();
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).not.toContain('ATTENDEE');
    expect(ics).toContain(`UID:${EVENT_ID}@hale`);
    expect(ics).toContain('SEQUENCE:1');
    expect(ics).toContain('DTSTART:20260722T143000Z');
  });

  it('renders at the most-private name level — an unauthenticated link names no child', async () => {
    const { db } = fakeDb({ events: [row()] });

    const ics = await loadEventInvite(db, validToken(), NOW);

    expect(ics).toContain('SUMMARY:Swim class');
    expect(ics).not.toContain('Maya');
  });

  it('returns null for a forged signature', async () => {
    const { db } = fakeDb({ events: [row()] });
    expect(await loadEventInvite(db, `${EVENT_ID}.forged-signature`, NOW)).toBeNull();
  });

  it('returns null once the family feed token is revoked (one revoke kills every event link)', async () => {
    const { db } = fakeDb({ events: [row({ icsShareToken: null })] });
    expect(await loadEventInvite(db, validToken(), NOW)).toBeNull();
  });

  it('returns null for a soft-deleted event', async () => {
    const { db } = fakeDb({ events: [row({ deletedAt: new Date('2026-07-20T00:00:00.000Z') })] });
    expect(await loadEventInvite(db, validToken(), NOW)).toBeNull();
  });

  it('returns null for an unknown event without querying on a malformed id', async () => {
    const { db, select } = fakeDb({ events: [] });

    expect(await loadEventInvite(db, 'not-a-uuid.signature', NOW)).toBeNull();
    expect(select).not.toHaveBeenCalled();

    expect(await loadEventInvite(db, validToken(), NOW)).toBeNull();
  });
});

describe('icsSequence — the revision derived from the event’s immutable audit trail', () => {
  it('is the count of audit rows for the event, so it rises exactly when the event changes', async () => {
    const { db } = fakeDb({ audit: [{ value: 3 }] });
    expect(await icsSequence(db, FAMILY_ID, EVENT_ID, 'REQUEST')).toBe(3);
  });

  it('is one above the count for a CANCEL, so a cancellation always supersedes the last invite', async () => {
    const { db } = fakeDb({ audit: [{ value: 3 }] });
    expect(await icsSequence(db, FAMILY_ID, EVENT_ID, 'CANCEL')).toBe(4);
  });
});

describe('sendEventInvite — the email leg', () => {
  const input = {
    familyId: FAMILY_ID,
    familyEventId: EVENT_ID,
    parentUserId: PARENT_ID,
    to: 'parent@example.com',
    subject: 'Swim class is on your calendar',
    text: 'Added Swim class — accept to put it on your calendar.',
    note: 'Added from your week plan.',
  };

  it('attaches the invite as text/calendar; method=REQUEST and keeps the caller’s visible body', async () => {
    const { db } = fakeDb({
      events: [row()],
      audit: [{ value: 1 }],
      prefs: [{ childNameLevel: 'first_name' }],
    });
    const { transport, send } = fakeTransport({ id: 'resend-1', error: null });

    const result = await sendEventInvite(input, { database: db, transport, now: NOW });

    expect(result).toEqual({ status: 'sent', providerMessageId: 'resend-1', sequence: 1 });
    const msg = sentMessage(send);
    expect(msg.to).toBe('parent@example.com');
    expect(msg.subject).toBe(input.subject);
    expect(msg.text).toBe(input.text);
    expect(msg.attachments?.[0]?.filename).toBe('invite.ics');
    expect(msg.attachments?.[0]?.contentType).toBe('text/calendar; charset=utf-8; method=REQUEST');

    const ics = attachedIcs(send);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('SUMMARY:Maya — Swim class');
    expect(ics).toContain('ATTENDEE');
    expect(ics).toContain('mailto:parent@example.com');
    expect(ics).toContain('ORGANIZER;CN=Hale:mailto:aloha@villagehale.com');
  });

  it('honors the recipient parent’s dial and the teen floor above it', async () => {
    const { db } = fakeDb({
      events: [row({ childDob: TEEN_DOB })],
      prefs: [{ childNameLevel: 'first_name' }],
    });
    const { transport, send } = fakeTransport({ id: 'resend-2', error: null });

    await sendEventInvite(input, { database: db, transport, now: NOW });

    const ics = attachedIcs(send);
    expect(ics).toContain('SUMMARY:an appointment');
    expect(ics).not.toContain('Maya');
    expect(ics).not.toContain('LOCATION:');
    expect(ics).not.toContain('DESCRIPTION:');
  });

  it('sends a CANCEL for a soft-deleted event at a sequence above the last invite', async () => {
    const { db } = fakeDb({
      events: [row({ deletedAt: new Date('2026-07-21T09:00:00.000Z') })],
      audit: [{ value: 2 }],
      prefs: [{ childNameLevel: 'generic' }],
    });
    const { transport, send } = fakeTransport({ id: 'resend-3', error: null });

    const result = await sendEventInvite({ ...input, method: 'CANCEL' }, {
      database: db,
      transport,
      now: NOW,
    });

    expect(result).toEqual({ status: 'sent', providerMessageId: 'resend-3', sequence: 3 });
    const ics = attachedIcs(send);
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:3');
  });

  it('never sends a REQUEST for an event that is gone, and never reaches the provider', async () => {
    const { db } = fakeDb({ events: [] });
    const { transport, send } = fakeTransport({ id: null, error: null });

    expect(await sendEventInvite(input, { database: db, transport, now: NOW })).toEqual({
      status: 'not_found',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an event that resolves to another family (family scope, rule #1)', async () => {
    // The row exists, but under a different family than the caller claims.
    const { db } = fakeDb({ events: [row()], prefs: [{ childNameLevel: 'first_name' }] });
    const { transport, send } = fakeTransport({ id: 'resend-4', error: null });

    const result = await sendEventInvite(
      { ...input, familyId: '99999999-9999-4999-8999-999999999999' },
      { database: db, transport, now: NOW },
    );

    expect(result).toEqual({ status: 'not_found' });
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a provider failure as a typed error rather than a silent success', async () => {
    const { db } = fakeDb({ events: [row()], prefs: [{ childNameLevel: 'generic' }] });
    const { transport } = fakeTransport({
      id: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests' },
    });

    expect(await sendEventInvite(input, { database: db, transport, now: NOW })).toEqual({
      status: 'error',
      message: 'Too many requests',
    });
  });
});
