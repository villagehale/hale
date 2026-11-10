import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { smsConsentCopyForScope } from '~/lib/channels/sms-consent-copy';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { askWriter } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  findReenrollableChannelOwner,
  findRevokedChannelOwner,
  reenrolOnStart,
} from './channel-state';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from './fakes';
import { type IntakeDeps, handleInboundSms } from './machine';
import { FakeTransport } from './transport';

/**
 * VIL-355 · one revoked `parent_channels` row, two different questions.
 *
 * "Is this number unsubscribed?" is number-keyed and membership-blind, and must stay
 * that way — every proactive send checks it, and a departed co-parent's number is the
 * last one Hale should decide it may text again. "Which household does this number
 * re-enter on START?" is a different question, and answering it from the same row was
 * the bug: departure revokes the seat AND the channel, so the revoked row kept naming
 * a family the person had left, and START re-enrolled them into it.
 *
 * Against the real DDL because the whole claim is which rows the scoping sees.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const NOW = new Date('2026-10-01T08:30:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', '');
  vi.stubEnv('COLD_START_LADDER_ENABLED', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seedRevokedChannel(seated: boolean): Promise<{
  familyId: string;
  userId: string;
}> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:left-the-family' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  if (seated) {
    await db.database.insert(schema.familyMembers).values({ familyId, userId, role: 'co_parent' });
  }
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: NOW,
    revokedAt: NOW,
  });
  return { familyId, userId };
}

describe('findReenrollableChannelOwner — START may only re-enter a seat that still exists', () => {
  it('hands back the owner while the seat stands', async () => {
    const { familyId, userId } = await seedRevokedChannel(true);

    expect(await findReenrollableChannelOwner(db.database, PHONE)).toEqual({ familyId, userId });
  });

  it('hands back nothing once the seat is gone — the number is a stranger again', async () => {
    const { familyId, userId } = await seedRevokedChannel(true);
    await db.database
      .delete(schema.familyMembers)
      .where(
        and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.userId, userId)),
      );

    expect(await findReenrollableChannelOwner(db.database, PHONE)).toBeNull();
    // …while the SUPPRESSION answer is unchanged: the number still said STOP, and the
    // proactive senders that read this must keep skipping it.
    expect(await findRevokedChannelOwner(db.database, PHONE)).toEqual({ familyId, userId });
  });

  it('does not accept a seat the person holds in some OTHER household', async () => {
    const { familyId, userId } = await seedRevokedChannel(false);
    const [other] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other household', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: other?.id as string, userId, role: 'co_parent' });

    expect(await findReenrollableChannelOwner(db.database, PHONE)).toBeNull();
    expect(await findRevokedChannelOwner(db.database, PHONE)).toEqual({ familyId, userId });
  });
});

describe('reenrolOnStart — which consent copy a row is recorded under', () => {
  it('records the new consent under v2 and leaves an earlier v1 consent on its own words', async () => {
    const { familyId, userId } = await seedRevokedChannel(true);
    const EARLIER = new Date('2026-08-01T08:30:00.000Z');
    await db.database.insert(schema.consentRecords).values({
      userId,
      familyId,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_service_messages:v1',
      policyVersion: 'v1',
      grantedAt: EARLIER,
    });

    await reenrolOnStart(
      db.database,
      { userId, familyId, phoneE164: PHONE, verbatimReply: 'START' },
      NOW,
    );

    const ledger = await db.database
      .select({
        consentScope: schema.consentRecords.consentScope,
        grantedAt: schema.consentRecords.grantedAt,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, userId));
    const earlier = ledger.filter((row) => row.grantedAt?.getTime() === EARLIER.getTime());
    const fresh = ledger.filter((row) => row.grantedAt?.getTime() !== EARLIER.getTime());

    expect(earlier.map((row) => row.consentScope)).toEqual(['sms_service_messages:v1']);
    expect(smsConsentCopyForScope('sms_service_messages:v1')).toBe(
      "Hale will text this number your family's weekly plan, reminders, and questions that need your OK. Msg&data rates may apply. Reply STOP anytime to turn this off.",
    );

    expect(fresh.map((row) => row.consentScope)).toEqual(['sms_service_messages:v2']);
    expect(smsConsentCopyForScope('sms_service_messages:v2')).toBe(
      "Hale texts this number about the kids' year: activities, registration dates, reminders, and questions that need the parent's OK. Hale stops when the parent asks, in any wording.",
    );
  });
});

/**
 * VIL-310 · START is a door onto an active channel like any other, so it keeps the same
 * invariant: a number that owns an active channel has no open caregiver invite. A number
 * that STOPped can be invited by another household (only an ACTIVE channel blocks an
 * invite), and the invite is read BEFORE the channel in the intake machine — so an invite
 * left open after START outranks the channel START just wrote, and the "yes" that answers
 * it tries to enrol the number a second time.
 */
describe('reenrolOnStart — closes the invite in flight on the same number', () => {
  async function seedOpenInviteFromAnotherFamily(): Promise<string> {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other household', provinceOrState: 'BC' })
      .returning({ id: schema.families.id });
    const [inviter] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:the-inviting-parent' })
      .returning({ id: schema.users.id });
    const familyId = family?.id as string;
    const invitedByUserId = inviter?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: invitedByUserId, role: 'primary_parent' });
    const [invite] = await db.database
      .insert(schema.caregiverInvites)
      .values({
        familyId,
        invitedByUserId,
        role: 'grandparent',
        displayName: 'Sam',
        phoneE164Encrypted: encryptString(PHONE),
        phoneE164Hash: phoneBlindIndex(PHONE),
        state: 'awaiting_caregiver_reply',
        expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
        createdAt: NOW,
      })
      .returning({ id: schema.caregiverInvites.id });
    return invite?.id as string;
  }

  function activeChannels() {
    return db.database
      .select({ id: schema.parentChannels.id })
      .from(schema.parentChannels)
      .where(
        and(
          eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(PHONE)),
          isNull(schema.parentChannels.revokedAt),
        ),
      );
  }

  function inviteAudit() {
    return db.database
      .select({ actionTaken: schema.auditLog.actionTaken, targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetTable, 'caregiver_invites'));
  }

  function intakeDeps(): IntakeDeps {
    return {
      transport: new FakeTransport(),
      threadMessage: async () => 'conv-1',
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: fakeRadar,
      answerComposer: fakeSilentAnswerComposer,
      openQuestions: fakeNoOpenQuestions,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => NOW.getTime()),
      consent: { read: async () => ({ verdict: 'yes' as const, target: 'none' as const }) },
      consentAsk: askWriter(),
      now: NOW,
    };
  }

  it('closes it as superseded_by_enrollment, and the number\'s "yes" never reaches it', async () => {
    const { familyId, userId } = await seedRevokedChannel(true);
    const inviteId = await seedOpenInviteFromAnotherFamily();

    await reenrolOnStart(
      db.database,
      { userId, familyId, phoneE164: PHONE, verbatimReply: 'START' },
      NOW,
    );

    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(invite).toEqual({ state: 'superseded_by_enrollment', closedAt: NOW });
    expect(await activeChannels()).toHaveLength(1);
    expect(await inviteAudit()).toEqual([
      { actionTaken: 'caregiver_invite_superseded_by_enrollment', targetId: inviteId },
    ]);

    // The number's next word. With the invite still armed this reached the invite's
    // accept, whose second channel insert the active-phone unique index refuses.
    await handleInboundSms(
      db.database,
      { from: PHONE, body: 'yes', providerId: 'in-yes-1', receivedAt: NOW },
      intakeDeps(),
    );

    expect(await activeChannels()).toHaveLength(1);
    const [after] = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, inviteId));
    expect(after?.state).toBe('superseded_by_enrollment');
    const grandparentSeats = await db.database
      .select({ userId: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.role, 'grandparent'));
    expect(grandparentSeats).toEqual([]);
  });

  it('positive control: with no invite in flight, START re-enrols and touches no invite', async () => {
    const { familyId, userId } = await seedRevokedChannel(true);

    await reenrolOnStart(
      db.database,
      { userId, familyId, phoneE164: PHONE, verbatimReply: 'START' },
      NOW,
    );

    expect(await activeChannels()).toHaveLength(1);
    expect(await db.database.select().from(schema.caregiverInvites)).toEqual([]);
    expect(await inviteAudit()).toEqual([]);
  });
});
