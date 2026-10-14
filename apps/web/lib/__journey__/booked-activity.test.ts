import { join } from 'node:path';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FollowupSweepDeps,
  defaultFollowupSweepDeps,
  runFollowupSweep,
} from '~/lib/channel/followup/run';
import { createFollowupVoice } from '~/lib/channel/followup/voice';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type EmailAlertPorts, alertParentForGmailSweep } from '~/lib/integrations/email-alert';
import { pipelineClient } from '~/lib/pipeline/client';
import type { FamilyChildRef } from '~/lib/sentinel';
import { loadCorrelationCandidates } from '~/lib/sentinel/candidates';
import { classifyChildEventEmail } from '~/lib/sentinel/pipeline';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { recordedModel } from '~/lib/testing/recorded-model';

/**
 * A REGISTRATION RECEIPT, END TO END — the receipt arrives, the text goes, the parent says
 * yes, the reminders appear, and the day after the first class Hale asks how it went.
 *
 * WHY THE MODEL IS RECORDED AND NOT SCRIPTED. The one failure this feature can have that
 * no other test can see is TRIAGE. `triage-child-event.md` used to answer `false` for
 * "shipping/order notifications", and a municipal rec-centre receipt reads as one — so a
 * confirmation would die at stage one and every test below the triage stage would stay
 * green, because every one of them injects a classification. A hand-written
 * `kind: 'booking_confirmation'` proves the plumbing AFTER the model and can never catch
 * that. So both sentinel turns here are REAL Claude, replayed by content address: revert
 * the skill edit and the key moves, the lookup misses, and this file fails loudly.
 *
 * THE RECORDING IS TRANSCODED FROM THE SENTINEL EVAL CACHE, not minted separately — same
 * skill, same tier, same forced-tool request, byte-identical user message, so a second
 * live recording would pay twice for one answer and then be free to drift from the corpus
 * the CI gate measures. See `__recordings__/mint-booked-activity.mjs`.
 *
 * WHAT IS FAKED, and only this: the SMS transport, and Gmail's body fetch (which serves
 * the eval corpus's own receipt fixture). The classifier, the correlation, the outbound
 * gate, the phone resolution, the offer row, the YES handler, the `family_events` write,
 * the reminder converger and the follow-up sweep's union reader are all production code
 * over real Postgres.
 *
 * THREE MUTATIONS, each one the file's reason to exist:
 *   1. Revert the `triage-child-event.md` confirmation carve-out  -> red at the text.
 *   2. Revert PR4's union reader                                  -> red at the ask.
 *   3. Revert PR4's `DueActivity.parentUserId`                    -> red at WHICH PHONE.
 *   4. Compose the ask from any other title                      -> red at the lookup.
 */

const RECORDINGS = join(import.meta.dirname, '__recordings__', 'booked-activity.json');
/** The follow-up ask's own turn, in its own file for two reasons. It is not transcoded:
 * no followup-voice fixture carries this class's title, so there is no eval-cache entry
 * to re-key and this one turn is recorded live (`HALE_RECORD=1`). And `booked-activity.json`
 * is WRITTEN WHOLESALE by `mint-booked-activity.mjs` out of the sentinel eval cache, so a
 * live turn parked in it would be deleted the next time either sentinel skill is edited. */
const VOICE_RECORDINGS = join(import.meta.dirname, '__recordings__', 'booked-followup-voice.json');

/** The eval corpus's own municipal receipt, and the family context the recording is keyed
 * on. Fixed ids and fixed ages rather than DB-derived ones: `ageInMonths` off a stored
 * date-of-birth drifts with the wall clock, and the extraction's user message — and
 * therefore the recording key — contains it. */
const CHILDREN: readonly FamilyChildRef[] = [
  { id: 'child-leo', name: 'Leo', ageInMonths: 60 },
  { id: 'child-maya', name: 'Maya', ageInMonths: 168 },
];
const RECEIVED_AT = '2026-07-20T09:00:00Z';
const FAMILY_TIMEZONE = 'America/Toronto';
const ENVELOPE = {
  messageId: 'gmail-rc-88214',
  subject: 'Registration Confirmation #RC-88214 — Leo Tremblay',
  from: 'City of Brookfield Recreation <noreply@recreation.brookfield.example.ca>',
  snippet:
    'Thank you for your registration. Preschool Swim Level 2, Saturdays 9:00 AM, begins August 1. Total paid: $96.00.',
  receivedAt: RECEIVED_AT,
};
const BODY =
  'Thank you for your registration.\n\nConfirmation number: RC-88214\nParticipant: Leo Tremblay\nProgram: Preschool Swim Level 2\nSessions: Saturdays 9:00 AM - 9:45 AM, August 1 to September 19, 2026\nLocation: Brookfield Leisure Centre, Pool 2\nTotal paid: $96.00 (Visa ending 4412)\n\nPlease arrive ten minutes early for the first class. Withdrawals are accepted up to seven days before the session start.\n\nCity of Brookfield Recreation';

/** The receipt lands on the Monday it was sent. */
const RECEIPT_AT = new Date('2026-07-20T13:00:00.000Z');
/** Inside the reminder converger's 8-day horizon of the Aug 1 first session. */
/** The morning after the first class — inside ACTIVITY_FOLLOWUP_MIN/MAX_AGE_DAYS. */
const MORNING_AFTER = new Date('2026-08-02T14:00:00.000Z');

/** THE CO-PARENT owns the Gmail connection, so the journey exercises the cross-parent
 * rule for free: the ask four days later must reach the mailbox the receipt arrived in
 * and no other phone (rule #5, D13). */
const PRIMARY_PHONE = '+14165550301';
const CO_PARENT_PHONE = '+14165550302';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

let db: TestDb;
let familyId: string;
let primaryUserId: string;
let coParentUserId: string;
let integrationId: string;

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
  vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
  vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
  // The reminder converger's voice stage is a model call; this journey is about the rows.
  vi.stubEnv('VOICE_DISABLED', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await seed();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seed(): Promise<void> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Tremblay',
      provinceOrState: 'ON',
      onboardingStage: 'sms_active',
    })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;
  integrationId = crypto.randomUUID();

  const [primary] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}-a@example.test`, name: 'Ana', timezone: FAMILY_TIMEZONE })
    .returning({ id: schema.users.id });
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}-b@example.test`, name: 'Ben', timezone: FAMILY_TIMEZONE })
    .returning({ id: schema.users.id });
  primaryUserId = primary?.id as string;
  coParentUserId = co?.id as string;

  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: primaryUserId, role: 'primary_parent' },
    { familyId, userId: coParentUserId, role: 'co_parent' },
  ]);
  await db.database.insert(schema.parentChannels).values([
    {
      userId: primaryUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PRIMARY_PHONE),
      phoneE164Hash: phoneBlindIndex(PRIMARY_PHONE),
      verifiedAt: RECEIPT_AT,
    },
    {
      userId: coParentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(CO_PARENT_PHONE),
      phoneE164Hash: phoneBlindIndex(CO_PARENT_PHONE),
      verifiedAt: RECEIPT_AT,
    },
  ]);
  for (const userId of [primaryUserId, coParentUserId]) {
    await recordWatchConsent(
      db.database,
      {
        familyId,
        userId,
        granted: true,
        verbatimReply: 'yes',
        interpretation: 'the parent said yes to being watched',
        channelMessageId: null,
      },
      RECEIPT_AT,
    );
  }
}

/**
 * The real alert ports: the REAL sentinel over a recorded model, the REAL gate, the REAL
 * phone read, the REAL thread. Only the wire and Gmail's body endpoint are stand-ins.
 */
function alertPorts(transport: FakeTransport): EmailAlertPorts {
  const recorded = recordedModel(RECORDINGS, pipelineClient);
  return {
    classify: async (envelope, familyTimezone) =>
      classifyChildEventEmail(envelope, {
        client: recorded.client(),
        children: CHILDREN,
        // The one Google stand-in: the corpus's own receipt, byte for byte.
        fetchBody: async () => BODY,
        familyTimezone,
        correlationCandidates: await loadCorrelationCandidates(db.database, familyId),
      }),
    gate: (request) => assertProactiveSendAllowed(request, buildOutboundGatePorts(db.database)),
    resolvePhone: resolveSendablePhone,
    transport,
    threadMessage: threadProactiveMessage,
    timeZone: async () => FAMILY_TIMEZONE,
  };
}

function sweepDeps(transport: FakeTransport): FollowupSweepDeps {
  return {
    ...defaultFollowupSweepDeps(),
    transport,
    // THE REAL COMPOSER, over a REAL recorded turn (rule #8). It was a stub returning a
    // canned sentence, and a stub cannot fail on the one thing this step is here to
    // prove: that the title the sweep hands the composer is the BOOKING's own class. A
    // scripted body says "Preschool Swim Level 2" no matter what the projection carried;
    // a recorded one is keyed on the request, so a sweep that composed from the wrong
    // title - or from no title - misses the lookup and this file goes red. The composer
    // turns a thrown miss into its own `model_failed` deferral, so the red arrives as
    // `activityAsked: 0`: re-record with `HALE_RECORD=1` and a live key, then commit the
    // JSON.
    voice: createFollowupVoice(recordedModel(VOICE_RECORDINGS, pipelineClient).client),
  };
}

describe('a registration receipt becomes a class Hale checks back on', () => {
  it('records the receipt and asks how it went, without texting about the email', async () => {
    // ── 1. THE RECEIPT ARRIVES ───────────────────────────────────────────────
    // The REAL sweep, the REAL sentinel, a recorded model. The parent is not texted.
    const transport = new FakeTransport();
    const outcomes = await alertParentForGmailSweep(
      db.database,
      {
        familyId,
        // The CONNECTING user is the co-parent: `integrations.user_id`, which is whose
        // mailbox this is.
        parentUserId: coParentUserId,
        integrationId,
        seeding: false,
        envelopes: [ENVELOPE],
        now: RECEIPT_AT,
      },
      alertPorts(transport),
    );

    expect(outcomes).toEqual([{ alert: 'backfill_suppressed', booking: 'recorded', going: null }]);
    expect(transport.sent).toEqual([]);

    const [booking] = await db.database
      .select()
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, familyId));
    expect(booking).toMatchObject({
      parentUserId: coParentUserId,
      providerHost: 'recreation.brookfield.example.ca',
      title: 'Preschool Swim Level 2',
      eventId: null,
    });
    expect(booking?.firstSessionAt.toISOString()).toBe('2026-08-01T13:00:00.000Z');
    // Rule #1, on the row this time: the confirmation number, the amount, the card and
    // the child's surname have no column and are therefore unwritable.
    //
    // THE CARD CANARY IS THE RECEIPT'S CLAUSE, NOT THE FOUR DIGITS. `4412` is hex, and
    // this JSON carries random uuids (`parentUserId`, the row id, the channel message).
    // An id that happens to spell those digits fails the check even though the card was
    // never written. `Visa ending 4412` is the clause in BODY, and a uuid cannot spell it.
    const stored = JSON.stringify(booking);
    for (const secret of ['RC-88214', '96.00', 'Visa ending 4412', 'Tremblay']) {
      expect(stored).not.toContain(secret);
    }

    await expect(
      db.database
        .select()
        .from(schema.emailAlertOffers)
        .where(eq(schema.emailAlertOffers.familyId, familyId)),
    ).resolves.toEqual([]);

    // ── 2. THE MORNING AFTER THE FIRST CLASS ─────────────────────────────────
    vi.stubEnv('FOLLOWUP_ASKS_FAMILY_ALLOWLIST', familyId);
    const askTransport = new FakeTransport();
    const result = await runFollowupSweep(db.database, sweepDeps(askTransport), MORNING_AFTER);

    expect(result.activityAsked).toBe(1);
    expect(askTransport.sent).toHaveLength(1);
    // THE FAR-SIDE ARTIFACT: the ask is on the phone of the parent whose mailbox the
    // receipt arrived in, and the other parent - who may not know this registration
    // happened - hears nothing.
    expect(askTransport.sent[0]?.to).toBe(CO_PARENT_PHONE);
    expect(askTransport.sent.map((sent) => sent.to)).not.toContain(PRIMARY_PHONE);
    // The locked how-it-went sentence names the class the receipt booked. The model
    // is not called for an activity ask (VIL-366).
    expect(askTransport.sent[0]?.body).toContain('Preschool Swim Level 2');
    expect(askTransport.sent[0]?.body).toContain(
      'How did Preschool Swim Level 2 go? One line is plenty.',
    );

    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit.map((row) => row.actionTaken)).toEqual(
      expect.arrayContaining(['activity_booking_recorded', 'followup_activity_asked']),
    );
    expect(audit.map((row) => row.actionTaken)).not.toContain('email_alert_sent');
    // Rule #1 across the whole trail: nothing in audit_log is a copy of the email.
    const trail = JSON.stringify(audit.map((row) => row.after));
    for (const leak of ['RC-88214', '96.00', 'Preschool Swim Level 2', 'brookfield']) {
      expect(trail).not.toContain(leak);
    }
  });
});
