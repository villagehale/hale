import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CoParentInvite } from '~/lib/channel/caregiver/invites';
import { SMS_CONSENT_SCOPE, revokeSmsChannel } from '~/lib/channels/sms-consent-core';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { POLICY_VERSION } from '~/lib/consent';
import { revokeMcpGrant } from '~/lib/mcp/oauth-store';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { CO_PARENT_INVITE_CONSENT_SCOPE, acceptCoParentInvite } from './accept';
import { departCoParent } from './depart';

/**
 * VIL-355 · departure against the REAL DDL, because every promise it makes is a
 * database one: the seat is claimed by a conditional DELETE, the channel by the
 * partial active index, and "the household's record is untouched" is only true of a
 * transaction that never names those tables.
 *
 * The household rows are seeded and re-read row for row. An identity assertion alone
 * is green on a function that does nothing, so every one of them is PAIRED with an
 * assertion that the actor's own rows did change.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_PHONE = '+16475550111';
/** One number per household, on BOTH sides: `parent_channels_phone_hash_active_idx` is
 * global, so two seated parents sharing a number could not both exist — a second
 * household seeded with the first one's number dies on the index, not on the code. */
const parentPhone = (household: number) => `+1416555${1000 + household}`;
const partnerPhone = (household: number) => `+1647555${2000 + household}`;
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DEPARTED_AT = new Date('2026-10-01T08:30:00.000Z');

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
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

let households = 0;

interface Household {
  familyId: string;
  parentUserId: string;
  coParentUserId: string;
  partnerPhone: string;
}

/** A household that went all the way through the real seating transaction: the
 * co-parent's consent row, channel and seat are the ones acceptance actually writes. */
async function seedSeatedHousehold(): Promise<Household> {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:household-${households}`, name: 'Ana' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(parentPhone(households)),
    phoneE164Hash: phoneBlindIndex(parentPhone(households)),
    verifiedAt: NOW,
  });

  const phoneE164 = partnerPhone(households);
  const [row] = await db.database
    .insert(schema.caregiverInvites)
    .values({
      familyId,
      invitedByUserId: parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(phoneE164),
      phoneE164Hash: phoneBlindIndex(phoneE164),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt: NOW,
    })
    .returning({ id: schema.caregiverInvites.id });
  const invite: CoParentInvite = {
    id: row?.id as string,
    familyId,
    invitedByUserId: parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164,
    state: 'awaiting_caregiver_reply',
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
  };
  const seated = await acceptCoParentInvite(db.database, {
    invite,
    verbatimReply: 'yes',
    now: NOW,
  });
  if (seated.outcome !== 'seated') {
    throw new Error(`seedSeatedHousehold: acceptance returned ${seated.outcome}`);
  }
  return { familyId, parentUserId, coParentUserId: seated.coParentUserId, partnerPhone: phoneE164 };
}

/** What the HOUSEHOLD owns, which a departure may not touch: the family's facts, the
 * departing parent's own long-lived thread, and an invite the other parent has out. */
async function seedHouseholdRecord(household: Household): Promise<{ openInviteId: string }> {
  await db.database.insert(schema.familyMemoryFacts).values({
    familyId: household.familyId,
    factType: 'routine',
    factKey: 'bedtime',
    factValue: { at: '19:30' },
  });
  await db.database.insert(schema.conversations).values([
    { familyId: household.familyId, noteKey: channelSmsNoteKey(household.coParentUserId) },
    { familyId: household.familyId, noteKey: channelSmsNoteKey(household.parentUserId) },
  ]);
  const [open] = await db.database
    .insert(schema.caregiverInvites)
    .values({
      familyId: household.familyId,
      invitedByUserId: household.parentUserId,
      role: 'grandparent',
      displayName: 'Rosa',
      phoneE164Encrypted: encryptString(OTHER_PHONE),
      phoneE164Hash: phoneBlindIndex(OTHER_PHONE),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt: NOW,
    })
    .returning({ id: schema.caregiverInvites.id });
  return { openInviteId: open?.id as string };
}

function facts(familyId: string) {
  return db.database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

function members(familyId: string) {
  return db.database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
}

function channelsOf(userId: string) {
  return db.database
    .select({
      id: schema.parentChannels.id,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.userId, userId));
}

function consentsOf(userId: string) {
  return db.database
    .select({
      consentType: schema.consentRecords.consentType,
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
    })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.userId, userId))
    .orderBy(schema.consentRecords.grantedAt);
}

function threads(familyId: string) {
  return db.database
    .select({ id: schema.conversations.id, noteKey: schema.conversations.noteKey })
    .from(schema.conversations)
    .where(eq(schema.conversations.familyId, familyId));
}

function auditRows(familyId: string) {
  return db.database
    .select({
      actor: schema.auditLog.actor,
      actionTaken: schema.auditLog.actionTaken,
      targetTable: schema.auditLog.targetTable,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
}

describe('departCoParent — one actor leaves, the household keeps its record', () => {
  it('revokes the channel, removes the seat, withdraws the consent, and keeps the thread', async () => {
    const household = await seedSeatedHousehold();
    const { openInviteId } = await seedHouseholdRecord(household);
    const factsBefore = await facts(household.familyId);

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({
      outcome: 'departed',
      channelRevoked: 1,
      mcpGrantsRevoked: 0,
      connectorsRevoked: 0,
      teenGrantsRevoked: 0,
      membershipRemoved: true,
      consentWithdrawn: 1,
      threadRetained: 1,
      channelRecordRetained: 1,
      inviteRecordRetained: 1,
      identityRetained: true,
    });

    // THE ACTOR'S OWN ROWS CHANGED — the positive control every identity assertion
    // below leans on.
    const coParentChannels = await channelsOf(household.coParentUserId);
    expect(coParentChannels).toHaveLength(1);
    expect(coParentChannels[0]?.revokedAt).toEqual(DEPARTED_AT);
    expect(await members(household.familyId)).toEqual([
      { userId: household.parentUserId, role: 'primary_parent' },
    ]);
    const coParentConsents = await consentsOf(household.coParentUserId);
    expect(coParentConsents).toEqual([
      {
        consentType: 'sms_service_messages',
        consentScope: 'sms_coparent_invite_reply',
        granted: true,
      },
      {
        consentType: 'sms_service_messages',
        consentScope: 'sms_coparent_invite_reply',
        granted: false,
      },
    ]);

    // THE HOUSEHOLD'S OWN ROWS DID NOT.
    expect(await facts(household.familyId)).toEqual(factsBefore);
    expect((await threads(household.familyId)).map((t) => t.noteKey).sort()).toEqual(
      [
        channelSmsNoteKey(household.coParentUserId),
        channelSmsNoteKey(household.parentUserId),
      ].sort(),
    );
    const inviterChannels = await channelsOf(household.parentUserId);
    expect(inviterChannels).toHaveLength(1);
    expect(inviterChannels[0]?.revokedAt).toBeNull();
    expect(await consentsOf(household.parentUserId)).toEqual([]);
    const [stillOpen] = await db.database
      .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.id, openInviteId));
    expect(stillOpen).toEqual({ state: 'awaiting_caregiver_reply', closedAt: null });
  });

  it('writes one audit row per effect, actored by the person leaving, with no number in it', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    await db.database
      .delete(schema.auditLog)
      .where(eq(schema.auditLog.familyId, household.familyId));

    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    const rows = await auditRows(household.familyId);
    expect(rows.map((r) => r.actionTaken).sort()).toEqual([
      'co_parent_access_withdrawn',
      'co_parent_channel_sms_revoked',
      'co_parent_departed',
    ]);
    for (const row of rows) {
      expect(row.actor).toBe(household.coParentUserId);
      // Not even masked: the departure rows say what was undone, never who. The digits
      // are the real seeded number, so this fails on any leak rather than on a literal
      // nobody writes.
      expect(JSON.stringify(row.after ?? {})).not.toContain(household.partnerPhone.slice(-4));
      expect(JSON.stringify(row.after ?? {})).not.toContain('Sam');
    }
  });

  it('refuses the primary parent — their door is the family sweep, and nothing is written', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    const consentsBefore = await consentsOf(household.parentUserId);

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.parentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({ outcome: 'not_departable', role: 'primary_parent' });
    expect((await members(household.familyId)).map((m) => m.role).sort()).toEqual([
      'co_parent',
      'primary_parent',
    ]);
    const inviterChannels = await channelsOf(household.parentUserId);
    expect(inviterChannels[0]?.revokedAt).toBeNull();
    expect(await consentsOf(household.parentUserId)).toEqual(consentsBefore);
    expect((await auditRows(household.familyId)).map((r) => r.actionTaken)).not.toContain(
      'co_parent_departed',
    );
  });

  it('is idempotent: a second departure finds no seat and writes nothing more', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });
    const consentsAfterFirst = await consentsOf(household.coParentUserId);
    const auditAfterFirst = await auditRows(household.familyId);

    const second = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: new Date(DEPARTED_AT.getTime() + 60_000),
    });

    expect(second).toEqual({ outcome: 'not_a_member' });
    expect(await consentsOf(household.coParentUserId)).toEqual(consentsAfterFirst);
    expect(await auditRows(household.familyId)).toEqual(auditAfterFirst);
  });

  /**
   * They texted STOP weeks ago, and only now ask to be erased. Seeded through the call
   * STOP actually makes (`revokeSmsChannel`, from the intake machine) rather than a
   * hand-written row, because the two are NOT the same ledger entry and the difference
   * is the whole test: STOP withdraws `sms_service_messages:<version>`, while the seat
   * this person holds was granted under the co-parent invite's own scope. Per-scope
   * latest-row-wins, so the invite grant is still standing on the day they leave and
   * departure withdraws it — one row, under its own scope, dated the departure.
   *
   * What is NOT repeated: the channel keeps the date STOP revoked it at (re-stamping
   * would move the instant CASL is read against), and the STOP's own withdrawal is not
   * written twice.
   */
  it('withdraws the invite-scope grant a STOP never touched, and re-revokes nothing', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    const STOPPED_AT = new Date('2026-09-20T09:00:00.000Z');
    const stopped = await revokeSmsChannel(
      db.database,
      { userId: household.coParentUserId, familyId: household.familyId },
      { now: STOPPED_AT },
    );
    expect(stopped).toEqual({ status: 'revoked' });

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({
      outcome: 'departed',
      channelRevoked: 0,
      mcpGrantsRevoked: 0,
      connectorsRevoked: 0,
      teenGrantsRevoked: 0,
      membershipRemoved: true,
      consentWithdrawn: 1,
      threadRetained: 1,
      channelRecordRetained: 1,
      inviteRecordRetained: 1,
      identityRetained: true,
    });
    expect((await channelsOf(household.coParentUserId))[0]?.revokedAt).toEqual(STOPPED_AT);
    // Asserted as a SET of three distinct rows rather than in order: `revokeSmsChannel`
    // files its withdrawal on the database's clock, so the ordering between it and the
    // dated fixtures depends on the day the suite is run.
    const ledger = await consentsOf(household.coParentUserId);
    expect(ledger).toHaveLength(3);
    expect(ledger).toEqual(
      expect.arrayContaining([
        {
          consentType: 'sms_service_messages',
          consentScope: CO_PARENT_INVITE_CONSENT_SCOPE,
          granted: true,
        },
        { consentType: 'sms_service_messages', consentScope: SMS_CONSENT_SCOPE, granted: false },
        {
          consentType: 'sms_service_messages',
          consentScope: CO_PARENT_INVITE_CONSENT_SCOPE,
          granted: false,
        },
      ]),
    );
    expect(await members(household.familyId)).toEqual([
      { userId: household.parentUserId, role: 'primary_parent' },
    ]);
    expect((await auditRows(household.familyId)).map((r) => r.actionTaken)).toContain(
      'co_parent_departed',
    );
  });

  it('leaves a caregiver of the same household seated — only the co-parent seat is this door', async () => {
    const household = await seedSeatedHousehold();
    const [caregiver] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:caregiver-${households}` })
      .returning({ id: schema.users.id });
    const caregiverUserId = caregiver?.id as string;
    await db.database.insert(schema.familyMembers).values({
      familyId: household.familyId,
      userId: caregiverUserId,
      role: 'grandparent',
    });

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: caregiverUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({ outcome: 'not_departable', role: 'grandparent' });
    expect((await members(household.familyId)).map((m) => m.role).sort()).toEqual([
      'co_parent',
      'grandparent',
      'primary_parent',
    ]);
  });
});

/** The other household's co-parent is not this one's: the door is scoped by family,
 * and a departure asked with the wrong family id must find no seat rather than take
 * the one it can see. */
describe('departCoParent — scoped to the family that was asked', () => {
  it('finds no seat when the actor is a co-parent of a DIFFERENT household', async () => {
    const one = await seedSeatedHousehold();
    const two = await seedSeatedHousehold();

    const result = await departCoParent(db.database, {
      familyId: two.familyId,
      actorUserId: one.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toEqual({ outcome: 'not_a_member' });
    expect((await members(one.familyId)).map((m) => m.role).sort()).toEqual([
      'co_parent',
      'primary_parent',
    ]);
  });

  /** A separated parent is one users row in two households, and the two doors record
   * DIFFERENT scopes — the SMS invite here, the forwardable link there. Leaving one
   * household may not end their consent in the other: a read that forgot to say which
   * family it meant would withdraw a scope this household never granted, and file the
   * row under this family while it was at it. */
  it('leaves the same person’s consent in another household standing', async () => {
    const one = await seedSeatedHousehold();
    const two = await seedSeatedHousehold();
    await db.database.insert(schema.consentRecords).values({
      userId: one.coParentUserId,
      familyId: two.familyId,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_join_origination',
      policyVersion: POLICY_VERSION,
      grantedAt: NOW,
    });

    const result = await departCoParent(db.database, {
      familyId: one.familyId,
      actorUserId: one.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toMatchObject({ outcome: 'departed', consentWithdrawn: 1 });
    expect((await consentsOf(one.coParentUserId)).filter((c) => c.granted === false)).toEqual([
      {
        consentType: 'sms_service_messages',
        consentScope: CO_PARENT_INVITE_CONSENT_SCOPE,
        granted: false,
      },
    ]);
    const inOtherHousehold = await db.database
      .select({ granted: schema.consentRecords.granted })
      .from(schema.consentRecords)
      .where(
        and(
          eq(schema.consentRecords.userId, one.coParentUserId),
          eq(schema.consentRecords.familyId, two.familyId),
        ),
      );
    expect(inOtherHousehold).toEqual([{ granted: true }]);
  });
});

/**
 * The seat was never the only door into the household. An MCP grant lives 30 days and
 * `verifyMcpBearer` never joined `family_members`; a connector row is swept by provider
 * and status with no membership check; a teen-access grant is keyed on the reader, not
 * on their seat. So a departure that removed only the seat left three live reads into
 * the children's data, held by somebody Hale had just told it would stop texting them.
 *
 * Every assertion here is PAIRED with the primary parent's equivalent row, untouched —
 * a revocation that took the whole family's access would pass a co-parent-only check.
 */
describe('departCoParent — every standing read into the household ends with the seat', () => {
  async function grantMcp(
    household: Household,
    userId: string,
    tokenHash: string,
    clientId = `client-${tokenHash}`,
  ) {
    await db.database
      .insert(schema.mcpOauthClients)
      .values({
        clientId,
        clientName: 'Example assistant',
        redirectUris: ['https://assistant.example/callback'],
      })
      .onConflictDoNothing();
    const [consent] = await db.database
      .insert(schema.consentRecords)
      .values({
        userId,
        familyId: household.familyId,
        consentType: 'mcp_third_party_model',
        granted: true,
        policyVersion: POLICY_VERSION,
        grantedAt: NOW,
      })
      .returning({ id: schema.consentRecords.id });
    const [grant] = await db.database
      .insert(schema.mcpGrants)
      .values({
        familyId: household.familyId,
        userId,
        clientId,
        consentRecordId: consent?.id as string,
        tokenHash,
        resource: 'https://app.example/api/mcp',
        scopes: ['week_plan.read'],
        expiresAt: new Date(DEPARTED_AT.getTime() + 30 * 24 * 3_600_000),
      })
      .returning({ id: schema.mcpGrants.id });
    return grant?.id as string;
  }

  async function connectGmail(household: Household, userId: string) {
    const [row] = await db.database
      .insert(schema.integrations)
      .values({
        familyId: household.familyId,
        userId,
        provider: 'gmail',
        status: 'active',
        oauthTokensEncrypted: encryptString('{"access_token":"tok"}'),
      })
      .returning({ id: schema.integrations.id });
    return row?.id as string;
  }

  async function grantTeenRead(household: Household, userId: string, childName: string) {
    const [child] = await db.database
      .insert(schema.children)
      .values({ familyId: household.familyId, name: childName, dateOfBirth: '2011-04-02' })
      .returning({ id: schema.children.id });
    const [grant] = await db.database
      .insert(schema.teenAccessGrants)
      .values({
        familyId: household.familyId,
        childId: child?.id as string,
        grantedToUserId: userId,
        scope: 'message_content',
        reason: 'checking in after a rough week',
        teenAssentAt: NOW,
        startsAt: NOW,
        expiresAt: new Date(DEPARTED_AT.getTime() + 3 * 24 * 3_600_000),
      })
      .returning({ id: schema.teenAccessGrants.id });
    return grant?.id as string;
  }

  function mcpGrant(id: string) {
    return db.database
      .select({ revokedAt: schema.mcpGrants.revokedAt })
      .from(schema.mcpGrants)
      .where(eq(schema.mcpGrants.id, id));
  }

  function connector(id: string) {
    return db.database
      .select({
        status: schema.integrations.status,
        enc: schema.integrations.oauthTokensEncrypted,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.id, id));
  }

  function teenGrant(id: string) {
    return db.database
      .select({ revokedAt: schema.teenAccessGrants.revokedAt })
      .from(schema.teenAccessGrants)
      .where(eq(schema.teenAccessGrants.id, id));
  }

  it('revokes the leaver’s MCP grant, connector and teen-access grant — and only theirs', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    const leaverMcp = await grantMcp(household, household.coParentUserId, 'hash-leaver');
    const stayerMcp = await grantMcp(household, household.parentUserId, 'hash-stayer');
    const leaverGmail = await connectGmail(household, household.coParentUserId);
    const stayerGmail = await connectGmail(household, household.parentUserId);
    const leaverTeen = await grantTeenRead(household, household.coParentUserId, 'Robin');
    const stayerTeen = await grantTeenRead(household, household.parentUserId, 'Robin');

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toMatchObject({
      outcome: 'departed',
      mcpGrantsRevoked: 1,
      connectorsRevoked: 1,
      teenGrantsRevoked: 1,
    });
    expect(await mcpGrant(leaverMcp)).toEqual([{ revokedAt: DEPARTED_AT }]);
    expect(await connector(leaverGmail)).toEqual([{ status: 'revoked', enc: null }]);
    expect(await teenGrant(leaverTeen)).toEqual([{ revokedAt: DEPARTED_AT }]);

    // THE PARENT WHO STAYED KEEPS EVERYTHING — the positive control.
    expect(await mcpGrant(stayerMcp)).toEqual([{ revokedAt: null }]);
    expect((await connector(stayerGmail))[0]?.status).toBe('active');
    expect((await connector(stayerGmail))[0]?.enc).not.toBeNull();
    expect(await teenGrant(stayerTeen)).toEqual([{ revokedAt: null }]);
  });

  it('writes one audit row per revoked door, and the tally counts nothing twice', async () => {
    const household = await seedSeatedHousehold();
    await grantMcp(household, household.coParentUserId, 'hash-audited');
    await connectGmail(household, household.coParentUserId);
    await grantTeenRead(household, household.coParentUserId, 'Robin');
    await db.database
      .delete(schema.auditLog)
      .where(eq(schema.auditLog.familyId, household.familyId));

    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    const rows = await auditRows(household.familyId);
    expect(rows.map((r) => r.actionTaken).sort()).toEqual([
      'co_parent_access_withdrawn',
      'co_parent_channel_sms_revoked',
      'co_parent_departed',
      'co_parent_integration_revoked',
      'co_parent_mcp_grant_revoked',
      'teen_content_access.revoked',
    ]);
    for (const row of rows) {
      expect(row.actor).toBe(household.coParentUserId);
    }
  });

  /** An already-revoked door is not revoked twice: the count is what THIS departure
   * undid, and a second `revoked_at` would move the date a CASL or PIPEDA read is
   * taken against. */
  it('leaves an already-revoked grant alone and counts it as zero', async () => {
    const household = await seedSeatedHousehold();
    const REVOKED_EARLIER = new Date('2026-09-20T09:00:00.000Z');
    const grantId = await grantMcp(household, household.coParentUserId, 'hash-already');
    await db.database
      .update(schema.mcpGrants)
      .set({ revokedAt: REVOKED_EARLIER })
      .where(eq(schema.mcpGrants.id, grantId));

    const result = await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(result).toMatchObject({ outcome: 'departed', mcpGrantsRevoked: 0 });
    expect(await mcpGrant(grantId)).toEqual([{ revokedAt: REVOKED_EARLIER }]);
  });

  /**
   * The house's `revokeMcpGrant` closes a connected assistant in THREE writes: the grant
   * row, the audit row, and a `mcp_third_party_model` granted=false row in the
   * append-only consent ledger. A departure that stamped only the first two left the
   * departed parent's third-party-model consent reading as GRANTED — under the ledger's
   * latest-row-wins convention that is what a consent-records list and a PIPEDA access
   * read would both say — while the grant behind it was closed. No access leak; an
   * unfaithful ledger, which is its own obligation (rule #1).
   *
   * Asserted against the row the HOUSE door writes for an equally-shaped grant rather
   * than against a copied scope string, so the two cannot drift apart quietly.
   */
  it('appends the same consent withdrawal the house’s revoke door appends, per grant', async () => {
    const household = await seedSeatedHousehold();
    const SHARED_CLIENT = 'client-shared-assistant';
    const stayerGrant = await grantMcp(
      household,
      household.parentUserId,
      'hash-house-door',
      SHARED_CLIENT,
    );
    await grantMcp(household, household.coParentUserId, 'hash-departure', SHARED_CLIENT);

    await departCoParent(db.database, {
      familyId: household.familyId,
      actorUserId: household.coParentUserId,
      now: DEPARTED_AT,
    });
    const houseRevoke = await revokeMcpGrant(
      db.database,
      { grantId: stayerGrant, familyId: household.familyId, userId: household.parentUserId },
      DEPARTED_AT,
    );

    expect(houseRevoke).toEqual({ status: 'revoked' });
    const houseWithdrawal = (await consentsOf(household.parentUserId)).filter(
      (row) => row.consentType === 'mcp_third_party_model' && row.granted === false,
    );
    // The positive control: the comparison below is worthless if the house door wrote
    // nothing either.
    expect(houseWithdrawal).toHaveLength(1);
    expect(houseWithdrawal[0]?.consentScope).toContain(SHARED_CLIENT);

    expect(
      (await consentsOf(household.coParentUserId)).filter(
        (row) => row.consentType === 'mcp_third_party_model' && row.granted === false,
      ),
    ).toEqual(houseWithdrawal);
  });

  /** The same person co-parents two households (the separated-parent case). Leaving one
   * may not close the door they still legitimately hold on the other. */
  it('leaves the same person’s grant in another household standing', async () => {
    const one = await seedSeatedHousehold();
    const two = await seedSeatedHousehold();
    const here = await grantMcp(one, one.coParentUserId, 'hash-here');
    await db.database.insert(schema.familyMembers).values({
      familyId: two.familyId,
      userId: one.coParentUserId,
      role: 'co_parent',
    });
    const there = await grantMcp(two, one.coParentUserId, 'hash-there');

    await departCoParent(db.database, {
      familyId: one.familyId,
      actorUserId: one.coParentUserId,
      now: DEPARTED_AT,
    });

    expect(await mcpGrant(here)).toEqual([{ revokedAt: DEPARTED_AT }]);
    expect(await mcpGrant(there)).toEqual([{ revokedAt: null }]);
  });

  /**
   * ALL OF IT, OR NONE OF IT — and nothing above proves that. Every other test reads
   * the state after a call that SUCCEEDED, which looks identical whether the six writes
   * committed together or one at a time. So the last write is forced to fail, and the
   * other five are re-read.
   *
   * The mutation this exists to kill: `database.transaction(...)` replaced by a plain
   * async function over the same handle. Under it the caller is told the departure
   * failed while the seat is gone, the channel is revoked, the grants are closed and the
   * ledger has a withdrawal in it — a co-parent removed from a household that still has
   * no record of removing them, and no way to tell which half happened.
   */
  it('commits nothing when the final audit write fails — the departure is one transaction', async () => {
    const household = await seedSeatedHousehold();
    await seedHouseholdRecord(household);
    const grantId = await grantMcp(household, household.coParentUserId, 'hash-atomic');
    const consentsBefore = await consentsOf(household.coParentUserId);

    await db.exec(`
      create or replace function refuse_departure_audit() returns trigger as $$
      begin raise exception 'audit write refused'; end;
      $$ language plpgsql;
      create trigger refuse_departure_audit_trg before insert on audit_log
        for each row when (new.action_taken = 'co_parent_departed')
        execute function refuse_departure_audit();
    `);
    try {
      await expect(
        departCoParent(db.database, {
          familyId: household.familyId,
          actorUserId: household.coParentUserId,
          now: DEPARTED_AT,
        }),
      ).rejects.toThrow(/audit write refused/);

      expect(await members(household.familyId)).toEqual(
        expect.arrayContaining([{ userId: household.coParentUserId, role: 'co_parent' }]),
      );
      expect((await channelsOf(household.coParentUserId))[0]?.revokedAt).toBeNull();
      expect(await mcpGrant(grantId)).toEqual([{ revokedAt: null }]);
      expect(await consentsOf(household.coParentUserId)).toEqual(consentsBefore);
    } finally {
      await db.exec('drop trigger if exists refuse_departure_audit_trg on audit_log');
    }
  });
});
