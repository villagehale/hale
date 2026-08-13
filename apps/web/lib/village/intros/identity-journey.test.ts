import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIdentityAsk } from '~/lib/channel/intake/fakes';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  defaultEmailCaptureDeps,
  handleEmailCaptureReply,
} from '~/lib/channel/email-capture/reply';
import { defaultNameCaptureDeps, handleNameCaptureReply } from '~/lib/channel/identity/name-reply';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb, seedChild } from '~/lib/testing/pglite';
import type { IntroEmailRequest, IntroEmailSender } from './email';
import { defaultVillageIntroReplyDeps, handleVillageIntroReply } from './reply';
import { type IntroSweepDeps, defaultIntroSweepDeps, runVillageIntroSweep } from './run';

/**
 * THE FOUNDER'S LIVE SCENARIO, end to end, against real Postgres.
 *
 * Two families arrive by text. Neither has a name and neither has an email, because
 * nothing in the SMS product ever collected either one: intake writes `users.name = null`
 * and `users.email = null`, and until this change the only writers were the mobile
 * onboarding body and the authed web settings form. Both families are asked whether they
 * want to be findable, both say yes, both get a card, both say yes again — and then the
 * introduction could never be written.
 *
 * WHY THIS RUNS ON REAL POSTGRES RATHER THAN THE CHAIN FAKES. Every load-bearing step
 * here is a QUERY: the capture window is a select over `channel_messages` filtered by
 * template key and status, the two writes are guarded UPDATEs whose `IS NULL` predicate
 * lives in the WHERE clause, and the sweep reads its families back through a three-table
 * join. A fake that returns whatever rows it was handed passes all of that with the
 * predicates deleted. The only thing that can prove the loop closes is the database.
 *
 * The two model-composed asks are Fakes (rule #8: their WORDS are the eval's job, their
 * gates are ask-voice.test.ts) and the transports are Fakes because nothing here may reach
 * a carrier. Every other seam is the production function.
 */

const M4K = 'M4K 1N2';

describe('two nameless, address-less families get introduced', () => {
  let db: TestDb;
  let database: Database;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('VILLAGE_INTROS_ENABLED', 'true');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  /**
   * A family exactly as SMS intake leaves one: `users.name` null, `users.email` null, the
   * family settled at `sms_active` with a coarse area and one toddler.
   */
  async function seedTextFamily(displayName: string, childName: string) {
    const [family] = await database
      .insert(schema.families)
      .values({
        displayName,
        provinceOrState: 'ON',
        areaCoarse: M4K,
        onboardingStage: 'sms_active',
      })
      .returning({ id: schema.families.id });
    const familyId = (family as { id: string }).id;

    const [user] = await database
      .insert(schema.users)
      .values({ email: null, name: null, timezone: 'America/Toronto' })
      .returning({ id: schema.users.id });
    const parentUserId = (user as { id: string }).id;

    await database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentUserId, role: 'primary_parent' });
    await seedChild(database, familyId, childName, 30);

    return { familyId, parentUserId };
  }

  /** Every gate open: consent and enrolment are settled elsewhere and are not what this
   * journey is about. */
  const openGate: OutboundGatePorts = {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    parentTimeZone: async () => 'UTC',
  };

  function sweepDeps(transport: FakeTransport, emails: IntroEmailRequest[]): IntroSweepDeps {
    const email: IntroEmailSender = {
      async send(request) {
        emails.push(request);
        return { status: 'sent', providerMessageId: 'msg-1' };
      },
    };
    return {
      // Every DB seam is production, including the consent ledger read that decides who
      // is discoverable — so the YES INTROS below is doing real work rather than being
      // assumed by a stub.
      ...defaultIntroSweepDeps(),
      buildGate: () => openGate,
      resolveSendablePhone: async (_db, userId) => `+1416555${userId.slice(0, 4)}`,
      transport,
      email,
      identityAsk: new FakeIdentityAsk({ status: 'composed', body: 'IDENTITY-ASK' }),
    };
  }

  it('asks, cards, gap-fills, captures, and introduces - with both audit rows', async () => {
    const one = await seedTextFamily('Wren family', 'Wren');
    const two = await seedTextFamily('Tomas family', 'Tomas');
    const transport = new FakeTransport();
    const emails: IntroEmailRequest[] = [];
    const deps = sweepDeps(transport, emails);
    const now = new Date('2026-08-13T15:00:00Z');

    // ── tick 1: the discoverability ask reaches both ──
    const asked = await runVillageIntroSweep(database, deps, now);
    expect(asked.asked).toBe(2);

    // ── both say YES INTROS ──
    for (const side of [one, two]) {
      const outcome = await handleVillageIntroReply(
        database,
        { familyId: side.familyId, parentUserId: side.parentUserId, body: 'YES INTROS', now },
        defaultVillageIntroReplyDeps(),
      );
      expect(outcome.status).toBe('discoverability_granted');
    }

    // ── tick 2: THE FIX. The pair forms and both are carded, though neither family has
    // a name or an address. Before this change the matcher refused here and the two
    // parents never heard another word.
    const paired = await runVillageIntroSweep(database, deps, now);
    expect(paired.proposed).toBe(1);
    expect(paired.carded).toBe(2);

    // ── both say YES INTRO to the card ──
    for (const side of [one, two]) {
      const outcome = await handleVillageIntroReply(
        database,
        { familyId: side.familyId, parentUserId: side.parentUserId, body: 'YES INTRO', now },
        defaultVillageIntroReplyDeps(),
      );
      expect(['intro_accepted']).toContain(outcome.status);
    }

    // ── tick 3: both sides owe a name AND an address, so each gets ONE ask ──
    const waiting = await runVillageIntroSweep(database, deps, now);
    expect(waiting.waiting).toEqual({ awaiting_email: 2, awaiting_name: 2 });
    expect(waiting.identityAsked).toBe(2);
    expect(waiting.introduced).toBe(0);
    // Not closed, and not miscounted as a delivery failure (rule #11).
    expect(waiting.introFailed).toBe(0);
    const [openPair] = await database
      .select({ closedAt: schema.villageIntroProposals.closedAt })
      .from(schema.villageIntroProposals);
    expect(openPair?.closedAt).toBeNull();

    // ── the parents answer. Two texts each, through the REAL capture handlers ──
    for (const [side, name, address] of [
      [one, "I'm Dana", 'dana@example.com'],
      [two, 'Sam Lee', 'sam@example.com'],
    ] as const) {
      const turn = { familyId: side.familyId, parentUserId: side.parentUserId, now };

      const named = await handleNameCaptureReply(
        database,
        { ...turn, body: name },
        defaultNameCaptureDeps(),
      );
      expect(named.status).toBe('captured');

      const mailed = await handleEmailCaptureReply(
        database,
        { ...turn, body: address },
        { ...defaultEmailCaptureDeps(), sendPendingInvite: async () => false },
      );
      // The receipt follows the question that was asked: this address was for an
      // introduction, not for calendar invites.
      expect(mailed).toEqual({
        status: 'captured',
        reply: "Got it - I'll make that introduction and use this address from now on.",
      });
    }

    // ── tick 4: nothing is missing any more, so the introduction goes ──
    const introduced = await runVillageIntroSweep(database, deps, now);
    expect(introduced.introduced).toBe(1);
    expect(introduced.waiting).toEqual({ awaiting_email: 0, awaiting_name: 0 });

    // ONE email, first names only, both addresses on the visible header.
    //
    // Order-independent on purpose: which family is side A is decided by comparing two
    // random uuids, so pinning "Dana is parentA" is a coin flip that fails one run in two.
    // What the introduction actually promises is that BOTH parents are on it, under their
    // first names only — and that is what is asserted.
    expect(emails).toHaveLength(1);
    expect([emails[0]?.parentA, emails[0]?.parentB]).toEqual(
      expect.arrayContaining([
        { firstName: 'Dana', email: 'dana@example.com' },
        { firstName: 'Sam', email: 'sam@example.com' },
      ]),
    );

    // ── the disclosure trail: one row per family, naming exactly what crossed ──
    const disclosed = await database
      .select({ familyId: schema.auditLog.familyId, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'village_intro_disclosed'));
    expect(disclosed.map((row) => row.familyId).sort()).toEqual(
      [one.familyId, two.familyId].sort(),
    );
    expect(disclosed[0]?.after).toMatchObject({
      channel: 'email',
      disclosedFields: ['parent_first_name', 'parent_email', 'child_stage', 'activity_title'],
    });

    // The pair is closed, and closed as introduced rather than as expired.
    const [settled] = await database
      .select({
        status: schema.villageIntroProposals.status,
        closedAt: schema.villageIntroProposals.closedAt,
      })
      .from(schema.villageIntroProposals);
    expect(settled?.status).toBe('both_accepted');
    expect(settled?.closedAt).not.toBeNull();
  });

  /**
   * The capture window is a real query, and this is the assertion the chain fakes cannot
   * make: a family Hale never asked has no window, so the same word is left for the coach.
   * Without it, every one-word reply in Hale's inbox would be a candidate name.
   */
  it('does not capture a name from a family Hale never asked', async () => {
    const side = await seedTextFamily('Unasked family', 'Ivo');

    const outcome = await handleNameCaptureReply(
      database,
      { familyId: side.familyId, parentUserId: side.parentUserId, body: 'Dana', now: new Date() },
      defaultNameCaptureDeps(),
    );

    expect(outcome).toEqual({ status: 'declined_to_claim' });
    const [user] = await database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, side.parentUserId));
    expect(user?.name).toBeNull();
  });

  /** The write's guard lives in the UPDATE's own WHERE, so a second answer loses in
   * Postgres rather than in JavaScript. */
  it('never overwrites a name that is already on file', async () => {
    const side = await seedTextFamily('Named family', 'Ivo');
    await database.insert(schema.channelMessages).values({
      familyId: side.familyId,
      parentUserId: side.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: 'parent_name_ask',
      status: 'sent',
    });

    const first = await defaultNameCaptureDeps().capture(database, {
      familyId: side.familyId,
      parentUserId: side.parentUserId,
      name: 'Dana',
    });
    const second = await defaultNameCaptureDeps().capture(database, {
      familyId: side.familyId,
      parentUserId: side.parentUserId,
      name: 'Someone Else',
    });

    expect(first).toBe('stored');
    expect(second).toBe('already_named');
    const [user] = await database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, side.parentUserId));
    expect(user?.name).toBe('Dana');

    // Rule #6: the write that happened has a row, the one that did not does not.
    const audits = await database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, side.familyId),
          eq(schema.auditLog.actionTaken, 'parent_name_captured'),
        ),
      );
    expect(audits).toHaveLength(1);
  });
});
