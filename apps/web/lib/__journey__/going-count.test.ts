import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type EmailAlertPorts, alertParentForGmailSweep } from '~/lib/integrations/email-alert';
import { GOING_COUNT_ENABLED_ENV } from '~/lib/integrations/going';
import { pipelineClient } from '~/lib/pipeline/client';
import { loadCorrelationCandidates } from '~/lib/sentinel/candidates';
import { classifyChildEventEmail } from '~/lib/sentinel/pipeline';
import type { FamilyChildRef } from '~/lib/sentinel';
import { recordedModel } from '~/lib/testing/recorded-model';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * WHO ELSE IS GOING, END TO END — three households register for one class, and only the
 * third ever hears a number.
 *
 * WHY THE MODEL IS RECORDED AND NOT SCRIPTED (rule #8). This file's first test is the ONLY
 * one in the repo that touches the feature's foundation: the session key is the
 * EXTRACTION's output, not the provider's — only the sender's domain comes off the
 * envelope, while the title and the first instant are one Sonnet sample over one email
 * body. So equality between two families' receipts for one class is PROBABLE, not
 * structural, and a hand-written `kind: 'booking_confirmation'` with a typed title proves
 * that equality by construction and can never fail on it. Both receipts here are REAL
 * bodies through the REAL sentinel, replayed by content address: edit either skill, change
 * the projection or move the model tier and the key moves, the lookup misses, and this
 * file fails loudly rather than quietly answering a question it was not asked.
 *
 * AN HONEST RED HERE IS WORTH MORE THAN A GREEN BUILT ON SEEDED ROWS. If the two keys ever
 * differ, that is the miss rate this feature's silence is made of, and the expectation
 * below is where it gets recorded.
 *
 * WHAT IS FAKED, and only this: the SMS transport, and Gmail's body fetch. The classifier,
 * the correlation, the outbound gate, the phone resolution, the booking write, the session
 * key, the count query, the frame, the audit row and the cron-visible outcome are all
 * production code over real Postgres.
 *
 * FOUR MUTATIONS, each one the file's reason to exist, each run and each red:
 *   1. Drop `cancelled_at IS NULL` from the count -> D hears "three", about a spot the
 *      provider had already released.
 *   2. Hard-code the floor at 1                   -> B hears "one other Hale family",
 *      which is the singleton the floor exists to close.
 *   3. Revert `already_held`                      -> C's second receipt speaks again, and
 *      C can difference the two numbers.
 *   4. Audit the counted families                 -> A's and B's trails grow a fifth verb.
 *
 * AND ONE THAT THIS FILE CANNOT SEE, stated rather than left as a silent gap: reverting
 * the `family_id <> $1` FILTER changes nothing here, because the recipient's own booking is
 * written AFTER the send and so is absent from every count read above. That guard is
 * mutation-pinned in `integrations/going.pglite.test.ts`, which reads the query directly
 * from a family that already holds a row.
 */

const RECORDINGS = join(import.meta.dirname, '__recordings__', 'going-count.json');

/** The family context the recordings are keyed on. Fixed ids and fixed ages rather than
 * DB-derived ones: `ageInMonths` off a stored date of birth drifts with the wall clock, and
 * the extraction's user message — and therefore the recording key — contains it.
 *
 * THE SAME LIST FOR EVERY HOUSEHOLD HERE, deliberately: what is under test is whether two
 * households' receipts for one class key the same, and varying the children would vary the
 * request and pay for four more recorded turns to prove nothing extra. */
const CHILDREN: readonly FamilyChildRef[] = [
  { id: 'child-leo', name: 'Leo', ageInMonths: 60 },
  { id: 'child-maya', name: 'Maya', ageInMonths: 168 },
];
const RECEIVED_AT = '2026-07-20T09:00:00Z';
const FAMILY_TIMEZONE = 'America/Toronto';

/**
 * TWO REAL RECEIPTS FOR ONE CLASS — the same municipal template, sent to two different
 * households.
 *
 * The first is the sentinel eval corpus's own `booking-municipal-rec-receipt`, byte for
 * byte. The second is what that provider's template produces for the NEXT family: the same
 * program, the same sessions line, the same location, and the three things that genuinely
 * differ between two copies — the salutation, the participant and the confirmation number.
 * Those three are exactly the variation the key has to survive, and inventing a second
 * PROGRAM line would have tested nothing.
 */
const RECEIPT_ONE = {
  envelope: {
    messageId: 'gmail-rc-88214',
    subject: 'Registration Confirmation #RC-88214 — Leo Tremblay',
    from: 'City of Brookfield Recreation <noreply@recreation.brookfield.example.ca>',
    snippet:
      'Thank you for your registration. Preschool Swim Level 2, Saturdays 9:00 AM, begins August 1. Total paid: $96.00.',
    receivedAt: RECEIVED_AT,
  },
  body: 'Thank you for your registration.\n\nConfirmation number: RC-88214\nParticipant: Leo Tremblay\nProgram: Preschool Swim Level 2\nSessions: Saturdays 9:00 AM - 9:45 AM, August 1 to September 19, 2026\nLocation: Brookfield Leisure Centre, Pool 2\nTotal paid: $96.00 (Visa ending 4412)\n\nPlease arrive ten minutes early for the first class. Withdrawals are accepted up to seven days before the session start.\n\nCity of Brookfield Recreation',
};

const RECEIPT_TWO = {
  envelope: {
    messageId: 'gmail-rc-88251',
    subject: 'Registration Confirmation #RC-88251 — Nora Okafor',
    from: 'City of Brookfield Recreation <noreply@recreation.brookfield.example.ca>',
    snippet:
      'Thank you for your registration. Preschool Swim Level 2, Saturdays 9:00 AM, begins August 1. Total paid: $96.00.',
    receivedAt: RECEIVED_AT,
  },
  body: 'Thank you for your registration.\n\nConfirmation number: RC-88251\nParticipant: Nora Okafor\nProgram: Preschool Swim Level 2\nSessions: Saturdays 9:00 AM - 9:45 AM, August 1 to September 19, 2026\nLocation: Brookfield Leisure Centre, Pool 2\nTotal paid: $96.00 (Mastercard ending 7130)\n\nPlease arrive ten minutes early for the first class. Withdrawals are accepted up to seven days before the session start.\n\nCity of Brookfield Recreation',
};

/** The receipt lands on the Monday it was sent. */
const RECEIPT_AT = new Date('2026-07-20T13:00:00.000Z');
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

interface Household {
  familyId: string;
  parentUserId: string;
  phone: string;
  integrationId: string;
}

let db: TestDb;
let phoneCounter = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = APP_KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = APP_KEY;
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
  vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The pglite instance is shared across this file and the count reads ACROSS families, so
  // the previous test's households would be counted into this one's sentence.
  await db.database.delete(schema.activityBookings);
  await db.database.delete(schema.auditLog);
  await db.database.delete(schema.channelMessages);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** One real household: a family, the parent whose mailbox this is, a verified number and a
 * live watch consent — everything the outbound chokepoint reads before it allows a text. */
async function household(displayName: string): Promise<Household> {
  phoneCounter += 1;
  const phone = `+1416555${String(1000 + phoneCounter).padStart(4, '0')}`;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName, provinceOrState: 'ON', onboardingStage: 'sms_active' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}@example.test`, name: 'Parent', timezone: FAMILY_TIMEZONE })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: RECEIPT_AT,
  });
  await recordWatchConsent(
    db.database,
    {
      familyId,
      userId: parentUserId,
      granted: true,
      verbatimReply: 'yes',
      interpretation: 'the parent said yes to being watched',
      channelMessageId: null,
    },
    RECEIPT_AT,
  );
  return { familyId, parentUserId, phone, integrationId: randomUUID() };
}

/** The real alert ports: the REAL sentinel over a recorded model, the REAL gate, the REAL
 * phone read, the REAL thread. Only the wire and Gmail's body endpoint are stand-ins. */
function alertPorts(
  who: Household,
  transport: FakeTransport,
  body: string,
): EmailAlertPorts {
  const recorded = recordedModel(RECORDINGS, pipelineClient);
  return {
    classify: async (envelope, familyTimezone) =>
      classifyChildEventEmail(envelope, {
        client: recorded.client(),
        children: CHILDREN,
        // The one Google stand-in: the provider's own receipt, byte for byte.
        fetchBody: async () => body,
        familyTimezone,
        correlationCandidates: await loadCorrelationCandidates(db.database, who.familyId),
      }),
    gate: (request) => assertProactiveSendAllowed(request, buildOutboundGatePorts(db.database)),
    resolvePhone: resolveSendablePhone,
    transport,
    threadMessage: threadProactiveMessage,
    timeZone: async () => FAMILY_TIMEZONE,
  };
}

/** One household's sweep over one receipt, through the shipped entry point. */
async function receiptArrives(
  who: Household,
  receipt: typeof RECEIPT_ONE,
  over: { messageId?: string } = {},
): Promise<{ text: string; going: string | null; booking: string | null }> {
  const transport = new FakeTransport();
  const [outcome] = await alertParentForGmailSweep(
    db.database,
    {
      familyId: who.familyId,
      parentUserId: who.parentUserId,
      integrationId: who.integrationId,
      seeding: false,
      envelopes: [{ ...receipt.envelope, messageId: over.messageId ?? receipt.envelope.messageId }],
      now: RECEIPT_AT,
    },
    alertPorts(who, transport, receipt.body),
  );
  return {
    text: transport.sent[0]?.body ?? '',
    going: outcome?.going ?? null,
    booking: outcome?.booking ?? null,
  };
}

function bookingsFor(familyId: string) {
  return db.database
    .select()
    .from(schema.activityBookings)
    .where(eq(schema.activityBookings.familyId, familyId));
}

describe('two real receipts for one class', () => {
  it('KEY EQUALITY: the two households key the same session, or this is where we learn they do not', async () => {
    // THE ONLY TEST THAT TOUCHES THE THESIS. Two different bodies — different salutation,
    // different participant, different confirmation number — through the real extraction.
    // If Sonnet reads "Preschool Swim Level 2" and "2026-08-01T09:00" off both, the keys
    // match and the count is possible; if it reads "Swim Level 2 (Sat)" off one, they do
    // not and the feature's whole failure mode is silence that looks like an empty room.
    const first = await household('Tremblay');
    const second = await household('Okafor');

    const one = await receiptArrives(first, RECEIPT_ONE);
    const two = await receiptArrives(second, RECEIPT_TWO);
    expect(one.booking).toBe('recorded');
    expect(two.booking).toBe('recorded');

    const [rowOne] = await bookingsFor(first.familyId);
    const [rowTwo] = await bookingsFor(second.familyId);
    // Not null on either side: a NULL key means the receipt was refused (a fallback title,
    // a freemail host), which is a different failure from two keys that disagree.
    expect(rowOne?.sessionKey).not.toBeNull();
    expect(rowTwo?.sessionKey).not.toBeNull();
    expect(rowTwo?.sessionKey).toBe(rowOne?.sessionKey);

    // ...and the key is the fold of three facts and nothing else — no confirmation number,
    // no participant, no amount, no card. It is a derived duplicate of three columns on the
    // same row, which is why it discloses nothing new (rule #1).
    for (const secret of ['RC-88214', 'RC-88251', 'Okafor', 'Tremblay', '96.00', '7130']) {
      expect(rowOne?.sessionKey).not.toContain(secret);
      expect(rowTwo?.sessionKey).not.toContain(secret);
    }
  });
});

describe('the third family into the class hears a number', () => {
  it('runs the whole arc: two quiet households, one count, one cancellation, one repeat', async () => {
    // ── A AND B REGISTER, AND HEAR NOTHING ABOUT EACH OTHER ──────────────────
    // Their receipts go through the same real path, because "only the third family ever
    // hears anything" is a claim about the product and not about the fixture.
    const a = await household('Family A');
    const b = await household('Family B');
    const firstIn = await receiptArrives(a, RECEIPT_ONE);
    expect(firstIn.going).toBe('below_floor');
    expect(firstIn.text).not.toContain('Hale families');

    const secondIn = await receiptArrives(b, RECEIPT_ONE);
    // One other family is a SINGLETON: hear that one neighbour uses Hale and you have
    // learned their child's weekly schedule. The floor is what closes that.
    expect(secondIn.going).toBe('below_floor');
    expect(secondIn.text).not.toContain('Hale families');

    // ── C IS THE THIRD, AND C IS TOLD ────────────────────────────────────────
    const c = await household('Family C');
    const thirdIn = await receiptArrives(c, RECEIPT_ONE);
    expect(thirdIn.going).toBe('shown');
    expect(thirdIn.booking).toBe('recorded');
    expect(thirdIn.text).toContain('with two other Hale families');
    // The population is named. A bare "two other families" would be a claim about the
    // class roster Hale cannot back.
    expect(thirdIn.text).not.toMatch(/(?<!Hale )other families/);
    // ...and the receipt's own details still never reach the wire.
    for (const secret of ['RC-88214', '96.00', '4412', 'Tremblay']) {
      expect(thirdIn.text).not.toContain(secret);
    }

    const cAudit = await db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.familyId, c.familyId), eq(schema.auditLog.actionTaken, 'email_alert_sent')),
      );
    // EXACTLY the number and the two flags. `toEqual`, not `toMatchObject`: the rule for
    // this row is enums and flags only, and a subset match would pass with the provider's
    // domain sitting beside the count.
    expect(cAudit[0]?.after).toEqual({
      kind: 'booking_confirmation',
      teenContent: false,
      othersCount: 2,
    });

    // ── THE FOURTH-AXIS ASSERTION: THE COUNTED HOUSEHOLDS WERE NEVER TOLD ────
    // A row in A's or B's trail saying their booking was counted into a text to another
    // family would tell them another Hale family is in their child's class — the same
    // disclosure, in reverse, to a household that was never asked. This is the assertion
    // that catches anybody "improving" the design by auditing the subjects.
    const subjectAudit = await db.database
      .select()
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.familyId, [a.familyId, b.familyId]));
    // Their OWN household and nothing else: the consent the seed recorded, the text their
    // own receipt produced, and the booking it wrote. No fifth verb, and no row whose
    // subject is C.
    expect(subjectAudit.map((row) => row.actionTaken).sort()).toEqual([
      'activity_booking_recorded',
      'activity_booking_recorded',
      'email_alert_sent',
      'email_alert_sent',
      'proactive_watch_granted',
      'proactive_watch_granted',
    ]);
    // ...and neither `email_alert_sent` carries a count, because neither of them was told
    // one. The positive control for this negative is C's row, asserted above.
    for (const row of subjectAudit) {
      expect(row.after).not.toMatchObject({ othersCount: 2 });
    }
    // One outbound text each — their own receipt's — and no second one when C registered.
    for (const who of [a, b]) {
      await expect(
        db.database
          .select()
          .from(schema.channelMessages)
          .where(eq(schema.channelMessages.familyId, who.familyId)),
      ).resolves.toHaveLength(1);
    }

    // ── B'S CLASS IS CALLED OFF, AND THE COUNT FALLS ─────────────────────────
    // Stamped directly: the closer itself is pinned end to end in
    // `booking.pglite.test.ts` (a cancellation email, the trail verb, the withdrawn
    // offer), and what is under test HERE is that the count reads `cancelled_at`.
    const [bBooking] = await bookingsFor(b.familyId);
    await db.database
      .update(schema.activityBookings)
      .set({ cancelledAt: new Date('2026-07-21T13:00:00.000Z') })
      .where(eq(schema.activityBookings.id, bBooking?.id as string));

    const d = await household('Family D');
    const fourthIn = await receiptArrives(d, RECEIPT_ONE);
    // THREE households hold this key and only TWO are live, so D hears two. This is the
    // assertion that would go red if the count stopped reading `cancelled_at`: it would
    // say three, about a household the provider had already released.
    expect(fourthIn.going).toBe('shown');
    expect(fourthIn.text).toContain('with two other Hale families');
    expect(fourthIn.text).not.toContain('three');
    // (And the state UNDER the floor is A's and B's own texts at the top of this arc: not
    // a zero, not a "you're the first" - the absence of a sentence.)

    // ── C GETS A SECOND RECEIPT FOR THE SAME SESSION ─────────────────────────
    // A provider that sends "Registration confirmed" and then "Payment receipt" is two
    // receipts for one class. Speaking again would let C difference the two numbers and
    // learn that exactly one household registered in between.
    const repeat = await receiptArrives(c, RECEIPT_ONE, { messageId: 'gmail-rc-88214-payment' });
    expect(repeat.going).toBe('repeat_receipt');
    expect(repeat.text).not.toContain('Hale families');
  });
});
