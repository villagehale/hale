import { join } from 'node:path';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { emailAlertAddHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext } from '~/lib/channel/router/route';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { threadProactiveMessage } from '~/lib/channel/thread';
import {
  type FollowupSweepDeps,
  defaultFollowupSweepDeps,
  runFollowupSweep,
} from '~/lib/channel/followup/run';
import { createFollowupVoice } from '~/lib/channel/followup/voice';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  type EmailAlertPorts,
  alertParentForGmailSweep,
} from '~/lib/integrations/email-alert';
import { defaultReminderRunDeps, runReminderCron } from '~/lib/loop/reminders/run';
import { pipelineClient } from '~/lib/pipeline/client';
import { loadCorrelationCandidates } from '~/lib/sentinel/candidates';
import { classifyChildEventEmail } from '~/lib/sentinel/pipeline';
import type { FamilyChildRef } from '~/lib/sentinel';
import { recordedModel } from '~/lib/testing/recorded-model';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { VoicePass } from '~/lib/channel/voice-pass/compose';

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
const HORIZON_AT = new Date('2026-07-26T13:00:00.000Z');
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

/** The voice pass, DARK: the flag is unset in tests, so the lane sends exactly what it
 * sends today. Required rather than optional (rule #11) — a test that forgot it would not
 * compile rather than quietly exercise a lane with no pass wired at all. */
const darkAside: VoicePass = {
  async compose() {
    return { status: 'no_aside', reason: 'lane_dark', refusals: [] };
  },
};

function alertPorts(transport: FakeTransport): EmailAlertPorts {
  const recorded = recordedModel(RECORDINGS, pipelineClient);
  return {
    aside: darkAside,
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

/** One inbound turn, read by the SHIPPED open-question reader over this family's real
 * rows — the reader whose answer decides whether a bare YES is unambiguous. */
async function yesFromCoParent(at: Date): Promise<HandlerContext> {
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId: coParentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      createdAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  const open = await defaultOpenQuestionReader().open(db.database, {
    familyId,
    parentUserId: coParentUserId,
    now: at,
  });
  return {
    familyId,
    parentUserId: coParentUserId,
    conversationId: crypto.randomUUID(),
    body: 'YES',
    send: async () => ({ providerMessageId: 'prov-yes', channel: 'sms' as const }),
    now: at,
    // The BARE-WORD path: with exactly one offer standing the word is unambiguous by
    // construction, which is the property `email-alert-offer.pglite.test.ts` pins. No
    // resolver reading is needed and none is faked.
    resolved: null,
    openQuestions: async () => open,
    inboundChannelMessageId: inbound?.id as string,
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
  it('runs the whole arc: the text, the YES, the reminders, and the ask on the right phone', async () => {
    // ── 1. THE RECEIPT ARRIVES ───────────────────────────────────────────────
    // The REAL sweep, the REAL sentinel, a recorded model. If triage answers false this
    // stops here with no text at all, which is the failure this file exists to catch.
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

    expect(outcomes).toEqual([
      {
        alert: 'sent',
        booking: 'recorded',
        going: 'going_dark',
        aside: { outcome: 'lane_dark', refusals: [] },
      },
    ]);
    expect(transport.sent).toHaveLength(1);
    const text = transport.sent[0]?.body ?? '';
    // The provider is the subject, the first session is named, and the one question is
    // the CTA. The model chose the title; the frame is Hale's.
    expect(text).toContain("City of Brookfield Recreation says you're in for Preschool Swim Level 2");
    expect(text).toContain('first one Saturday, Aug 1 at 9:00 a.m.');
    expect(text).toContain('Want it on your calendar?');
    // The receipt's own details have no column and never reach the wire.
    expect(text).not.toContain('RC-88214');
    expect(text).not.toContain('96.00');
    expect(text).not.toContain('4412');
    expect(text).not.toContain('Tremblay');
    // ...and it went to the mailbox's owner.
    expect(transport.sent[0]?.to).toBe(CO_PARENT_PHONE);

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
    const stored = JSON.stringify(booking);
    for (const secret of ['RC-88214', '96.00', '4412', 'Tremblay']) {
      expect(stored).not.toContain(secret);
    }

    const [offer] = await db.database
      .select()
      .from(schema.emailAlertOffers)
      .where(eq(schema.emailAlertOffers.familyId, familyId));
    expect(offer).toMatchObject({ kind: 'booking_confirmation', parentUserId: coParentUserId });

    // ── 2. THE PARENT SAYS YES ───────────────────────────────────────────────
    const verdict = await emailAlertAddHandler().handle(
      db.database,
      await yesFromCoParent(new Date(RECEIPT_AT.getTime() + 60_000)),
    );
    expect(verdict).toMatchObject({ claimed: true, outcome: 'added' });

    const [placed] = await db.database
      .select()
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, familyId));
    // `parent` is the ONE source both the reminder scheduler and the weekly-plan composer
    // read, which is why the offer writes it.
    expect(placed).toMatchObject({ title: 'Preschool Swim Level 2', source: 'parent' });
    // ...and the booking now points at it, so the follow-up reader knows which of the two
    // readers owns the ask.
    const [stamped] = await db.database
      .select()
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, familyId));
    expect(stamped?.eventId).toBe(placed?.id);

    // ── 3. THE REMINDERS APPEAR, ONCE THE CLASS IS INSIDE THE HORIZON ────────
    // Through the SHIPPED deps: the source filter lives inside `loadHorizonEvents`, and
    // no fake of it can be asked whether the real filter admits this row.
    await runReminderCron(db.database, defaultReminderRunDeps(), HORIZON_AT);
    const reminders = await db.database
      .select()
      .from(schema.eventReminders)
      .where(
        and(
          eq(schema.eventReminders.familyId, familyId),
          eq(schema.eventReminders.eventRef, placed?.id as string),
        ),
      );
    // TWO OFFSETS, FOR BOTH PARENTS - and the contrast with step 4 is the point. A
    // reminder is about the FAMILY's own calendar row, so it reaches the household; the
    // "how did it go?" ask is about a mailbox Hale read, so it reaches one phone.
    const byParent = new Map<string, string[]>();
    for (const row of reminders) {
      byParent.set(row.parentUserId, [...(byParent.get(row.parentUserId) ?? []), row.offset]);
    }
    expect([...byParent.keys()].sort()).toEqual([primaryUserId, coParentUserId].sort());
    for (const offsets of byParent.values()) expect(offsets.sort()).toEqual(['-P1D', '-PT1H']);

    // ── 4. THE MORNING AFTER THE FIRST CLASS ─────────────────────────────────
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
    // ...and Claude's own words name the class the receipt booked - the composer was
    // handed the booking's title and nothing else about this household.
    expect(askTransport.sent[0]?.body).toContain('Preschool Swim Level 2');

    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit.map((row) => row.actionTaken)).toEqual(
      expect.arrayContaining([
        'email_alert_sent',
        'activity_booking_recorded',
        'email_alert_event_added',
        'followup_activity_asked',
      ]),
    );
    // Rule #1 across the whole trail: nothing in audit_log is a copy of the email.
    const trail = JSON.stringify(audit.map((row) => row.after));
    for (const leak of ['RC-88214', '96.00', 'Preschool Swim Level 2', 'brookfield']) {
      expect(trail).not.toContain(leak);
    }
  });
});
