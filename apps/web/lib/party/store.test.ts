import { schema } from '@hale/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { guestNameKey, submitRsvp } from './store';

/**
 * VIL-245 · M10 — the guest write path, tested for the promise the RSVP page makes:
 * a guest who does not ask for a reminder leaves NO contact data behind.
 *
 * These assertions read the actual insert payload rather than a return value, because
 * the promise is about what lands in the database. The table's CHECK constraint is the
 * second line of the same defence (packages/db/drizzle/0074_party_rsvp.sql); this is
 * the first, and it is the one that fails in CI.
 */

beforeAll(() => {
  // encryptString reads it at call time; the opt-in path must be exercised for real
  // rather than stubbed, because "did we encrypt" is half of what is under test.
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

const LIVE_PARTY = {
  inviteId: '00000000-0000-4000-8000-00000000aaaa',
  familyId: '00000000-0000-4000-8000-00000000bbbb',
  cancelled: false,
};

describe('submitRsvp — data minimisation', () => {
  it('stores NO contact data when the guest did not ask for a reminder', async () => {
    const fake = makeFakeDb();
    const result = await submitRsvp(fake.db, LIVE_PARTY, {
      displayName: 'Priya',
      response: 'yes',
      headcount: 3,
      reminderPhone: null,
    });

    expect(result.status).toBe('recorded');
    const insert = fake.writes.find((w) => w.table === schema.partyRsvps);
    expect(insert).toBeDefined();
    expect(insert?.payload).toMatchObject({
      displayName: 'Priya',
      response: 'yes',
      headcount: 3,
      reminderOptInAt: null,
      phoneE164Encrypted: null,
      phoneE164Hash: null,
    });
    // Nothing anywhere in the written row may resemble a phone number.
    expect(JSON.stringify(insert?.payload)).not.toMatch(/\+?1?\d{10}/);
  });

  it('stores an encrypted number ONLY alongside the consent timestamp that permits it', async () => {
    const fake = makeFakeDb();
    await submitRsvp(fake.db, LIVE_PARTY, {
      displayName: 'Sam',
      response: 'yes',
      headcount: 1,
      reminderPhone: '416-555-0142',
    });

    const payload = fake.writes.find((w) => w.table === schema.partyRsvps)?.payload as
      | Record<string, unknown>
      | undefined;
    expect(payload?.reminderOptInAt).toBeInstanceOf(Date);
    expect(typeof payload?.phoneE164Encrypted).toBe('string');
    expect(typeof payload?.phoneE164Hash).toBe('string');
    // The plaintext number is never what is stored.
    expect(String(payload?.phoneE164Encrypted)).not.toContain('4165550142');
    expect(String(payload?.phoneE164Hash)).not.toContain('4165550142');
  });

  it('refuses the whole submission when the reminder number is unusable', async () => {
    const fake = makeFakeDb();
    const result = await submitRsvp(fake.db, LIVE_PARTY, {
      displayName: 'Sam',
      response: 'yes',
      headcount: 1,
      reminderPhone: 'call me maybe',
    });

    // Recording the RSVP but silently dropping the opt-in would tell the guest they
    // will be reminded when they will not be.
    expect(result).toEqual({ status: 'invalid', field: 'phone' });
    expect(fake.writes.filter((w) => w.table === schema.partyRsvps)).toHaveLength(0);
  });

  it('rejects a blank name and an out-of-range headcount without writing anything', async () => {
    const fake = makeFakeDb();
    expect(
      await submitRsvp(fake.db, LIVE_PARTY, {
        displayName: '   ',
        response: 'yes',
        headcount: 1,
        reminderPhone: null,
      }),
    ).toEqual({ status: 'invalid', field: 'name' });
    expect(
      await submitRsvp(fake.db, LIVE_PARTY, {
        displayName: 'Sam',
        response: 'yes',
        headcount: 0,
        reminderPhone: null,
      }),
    ).toEqual({ status: 'invalid', field: 'headcount' });
    expect(
      await submitRsvp(fake.db, LIVE_PARTY, {
        displayName: 'Sam',
        response: 'yes',
        headcount: 99,
        reminderPhone: null,
      }),
    ).toEqual({ status: 'invalid', field: 'headcount' });
    expect(fake.writes.filter((w) => w.table === schema.partyRsvps)).toHaveLength(0);
  });

  it('refuses to record an RSVP for a cancelled party', async () => {
    const fake = makeFakeDb();
    const result = await submitRsvp(
      fake.db,
      { ...LIVE_PARTY, cancelled: true },
      { displayName: 'Priya', response: 'yes', headcount: 1, reminderPhone: null },
    );
    expect(result).toEqual({ status: 'cancelled' });
    expect(fake.writes.filter((w) => w.table === schema.partyRsvps)).toHaveLength(0);
  });

  it('writes an audit row for the guest write (rule #6)', async () => {
    const fake = makeFakeDb();
    await submitRsvp(fake.db, LIVE_PARTY, {
      displayName: 'Priya',
      response: 'yes',
      headcount: 1,
      reminderPhone: null,
    });
    const audit = fake.writes.find((w) => w.table === schema.auditLog);
    expect(audit?.payload).toMatchObject({
      familyId: LIVE_PARTY.familyId,
      actionTaken: 'party_rsvp_submitted',
      targetTable: 'party_rsvps',
    });
    // The audit trail must not carry the guest's name — it is a third party's, and
    // audit_log is immutable and PIPEDA-exportable to the FAMILY.
    expect(JSON.stringify(audit?.payload)).not.toContain('Priya');
  });
});

describe('guestNameKey', () => {
  it('folds case and whitespace so one guest answering twice is one row', () => {
    expect(guestNameKey('Priya  Raman')).toBe(guestNameKey('  priya raman '));
  });

  it('keeps genuinely different guests apart', () => {
    expect(guestNameKey('Priya')).not.toBe(guestNameKey('Priyanka'));
  });
});
