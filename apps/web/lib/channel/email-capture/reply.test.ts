import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_ALREADY_TAKEN_REPLY } from '~/lib/channel/router/copy';
import { CALENDAR_EMAIL_ASK_TEMPLATE_KEY } from '~/lib/loop/templates/calendar-invite';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type EmailCaptureDeps,
  type EmailCaptureWrite,
  defaultEmailCaptureDeps,
  handleEmailCaptureReply,
  soleEmailAddress,
} from './reply';

/**
 * VIL-249 · M13 — reading the one answer Hale asked for.
 *
 * The shape check is the whole safety story on this path: what it claims becomes the
 * account's contact address, so the cases that must FALL THROUGH matter as much as the
 * ones that must be caught, and both are pinned here. The store half runs against a
 * real Postgres, because "never overwrite" and "unique address" are conditions the
 * database enforces and a stub would only restate.
 */

const NOW = new Date('2026-07-24T15:00:00.000Z');
const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const DB = {} as Database;

describe('soleEmailAddress — what counts as an answer', () => {
  it.each([
    ['dana@example.com', 'dana@example.com'],
    ['  Dana@Example.COM  ', 'dana@example.com'],
    ['dana@example.com.', 'dana@example.com'],
    ["it's dana@example.com", 'dana@example.com'],
    ['sure dana@example.com', 'dana@example.com'],
    ['<dana@example.com>', 'dana@example.com'],
  ])('reads %j as an address', (body, expected) => {
    expect(soleEmailAddress(body)).toBe(expected);
  });

  it.each([
    // A request, not an answer — the coach owns sentences.
    ['email dana@example.com about the swim class on Thursday'],
    // Two addresses is a question Hale must not guess at.
    ['dana@example.com or sam@example.com'],
    ['no thanks'],
    ['STOP'],
    ['yes'],
    ['@dana'],
    ['dana@localhost'],
    [''],
  ])('declines %j', (body) => {
    expect(soleEmailAddress(body)).toBeNull();
  });
});

describe('handleEmailCaptureReply', () => {
  function deps(
    overrides: Partial<EmailCaptureDeps> & { write?: EmailCaptureWrite; invited?: boolean } = {},
  ) {
    const captured: string[] = [];
    const invites: string[] = [];
    const base: EmailCaptureDeps = {
      wasAsked: async () => true,
      capture: async (_db, input) => {
        captured.push(input.address);
        return overrides.write ?? 'stored';
      },
      sendPendingInvite: async (_db, input) => {
        invites.push(input.parentUserId);
        return overrides.invited ?? true;
      },
    };
    return { deps: { ...base, ...overrides } as EmailCaptureDeps, captured, invites };
  }

  const turn = (body: string) => ({ familyId: FAMILY, parentUserId: PARENT, body, now: NOW });

  it('stores the address, acks it, and sends the invite that was waiting', async () => {
    const { deps: d, captured, invites } = deps();

    const outcome = await handleEmailCaptureReply(DB, turn('dana@example.com'), d);

    expect(captured).toEqual(['dana@example.com']);
    expect(invites).toEqual([PARENT]);
    expect(outcome).toEqual({
      status: 'captured',
      reply: "Got it - invites will go there from now on. The last one's on its way.",
    });
  });

  it('promises no invite when there was no placement waiting', async () => {
    const { deps: d } = deps({ invited: false });
    const outcome = await handleEmailCaptureReply(DB, turn('dana@example.com'), d);
    expect(outcome).toEqual({
      status: 'captured',
      reply: 'Got it - invites will go there from now on.',
    });
  });

  it('falls through when Hale never asked this family for an address', async () => {
    const { deps: d, captured } = deps({ wasAsked: async () => false });

    expect(await handleEmailCaptureReply(DB, turn('dana@example.com'), d)).toEqual({
      status: 'declined_to_claim',
    });
    // Nothing was written on the strength of a message nobody asked for.
    expect(captured).toEqual([]);
  });

  it('falls through — never overwrites — when the parent already has an address', async () => {
    const { deps: d, invites } = deps({ write: 'already_has_email' });

    expect(await handleEmailCaptureReply(DB, turn('dana@example.com'), d)).toEqual({
      status: 'declined_to_claim',
    });
    expect(invites).toEqual([]);
  });

  it('says so when the address belongs to another account, rather than failing silently', async () => {
    const { deps: d, invites } = deps({ write: 'address_taken' });

    expect(await handleEmailCaptureReply(DB, turn('dana@example.com'), d)).toEqual({
      status: 'address_taken',
      reply: EMAIL_ALREADY_TAKEN_REPLY,
    });
    expect(invites).toEqual([]);
  });

  it('leaves an ambiguous message to the coach', async () => {
    const { deps: d, captured } = deps();
    const outcome = await handleEmailCaptureReply(
      DB,
      turn('can you email dana@example.com the details'),
      d,
    );
    expect(outcome).toEqual({ status: 'declined_to_claim' });
    expect(captured).toEqual([]);
  });
});

describe('the production store (real Postgres)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsubscribe-secret');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  async function ask(familyId: string, parentUserId: string, status: 'sent' | 'suppressed_consent') {
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'approval',
      templateKey: CALENDAR_EMAIL_ASK_TEMPLATE_KEY,
      status,
    });
  }

  it('counts only an ask that reached the parent', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const { wasAsked } = defaultEmailCaptureDeps();

    expect(await wasAsked(db.database, familyId)).toBe(false);
    await ask(familyId, parentUserId, 'suppressed_consent');
    expect(await wasAsked(db.database, familyId)).toBe(false);
    await ask(familyId, parentUserId, 'sent');
    expect(await wasAsked(db.database, familyId)).toBe(true);
  });

  it('writes the address onto the account with an audit row (rule #6)', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await db.database
      .update(schema.users)
      .set({ email: null })
      .where(eq(schema.users.id, parentUserId));

    const written = await defaultEmailCaptureDeps().capture(db.database, {
      familyId,
      parentUserId,
      address: 'dana@example.com',
    });

    expect(written).toBe('stored');
    const [user] = await db.database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId));
    expect(user?.email).toBe('dana@example.com');

    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits).toEqual([
      {
        actionTaken: 'parent_email_captured',
        after: {
          source: 'sms_reply',
          consentBasis: 'answered_hales_direct_ask',
          address: 'dana@example.com',
        },
      },
    ]);
  });

  it('refuses an address another account already holds', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await db.database
      .update(schema.users)
      .set({ email: null })
      .where(eq(schema.users.id, parentUserId));
    await db.database.insert(schema.users).values({ email: 'taken@example.com', name: 'Someone' });

    const written = await defaultEmailCaptureDeps().capture(db.database, {
      familyId,
      parentUserId,
      address: 'taken@example.com',
    });

    expect(written).toBe('address_taken');
    const [user] = await db.database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId));
    expect(user?.email).toBeNull();
  });

  it('never overwrites an address the parent already has', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);

    const written = await defaultEmailCaptureDeps().capture(db.database, {
      familyId,
      parentUserId,
      address: 'new@example.com',
    });

    expect(written).toBe('already_has_email');
    const [user] = await db.database
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId));
    expect(user?.email).toBe(`${familyId}@example.test`);
  });
});
