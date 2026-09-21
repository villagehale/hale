import { randomUUID } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { loadCorrelationCandidates } from '~/lib/sentinel/candidates';
import { correlateExtraction } from '~/lib/sentinel/correlate';
import { classifyChildEventEmail } from '~/lib/sentinel/pipeline';
import type {
  ExtractedEvent,
  ExtractionKind,
  FamilyChildRef,
  SentinelClassification,
} from '~/lib/sentinel';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  BOOKING_CONFIDENCE_FLOOR,
  bookingDraft,
  readDueBookings,
  recordActivityBooking,
  stampBookingEvent,
} from './booking';
import { type EmailAlertPorts, alertParentForEmail, alertParentForGmailSweep } from './email-alert';
import {
  handleEmailAlertOfferReply,
  loadOpenEmailAlertOffers,
} from './email-alert-offer';

/**
 * THE BOOKING — the decision, the write, and the two things that must not happen.
 *
 * pglite rather than fakes, because the questions that matter here are SQL: the unique
 * index on (connection, message) that makes a re-fired sweep idempotent, the left join in
 * `readDueBookings` that decides whether the placement reader or this one owns a due item,
 * and — through the REAL `loadCorrelationCandidates` — whether a receipt for a class the
 * family already holds is offered a second time. A fake reader answers all three from
 * whatever it was handed.
 *
 * The classifier is an injected PORT with a literal result, not a mocked Claude (rule #8):
 * its quality is the eval suite's job, and what is under test here is what Hale DOES with
 * a verdict.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let INTEGRATION: string;

const NOW = new Date('2026-09-17T15:00:00.000Z');
/** A Saturday morning in Toronto, nine days out — past the reminder horizon on purpose,
 * so nothing in this file depends on the converger. */
const FIRST_SESSION = '2026-09-26T13:00:00.000Z';
const PHONE = '+14165551234';

const ENVELOPE = {
  subject: 'Registration Confirmation - Swim Level 2',
  from: 'Brookfield Recreation <noreply@recreation.brookfield.example.ca>',
  snippet: "You're registered for Swim Level 2.",
  receivedAt: '2026-09-17T14:00:00.000Z',
};

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  INTEGRATION = randomUUID();
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function classified(
  over: Partial<ExtractedEvent> & {
    kind?: ExtractionKind;
    teenContent?: boolean;
    teenAttributed?: boolean;
    sourceConfidence?: number;
    matchedEventRef?: SentinelClassification['extraction'] extends null
      ? never
      : { table: 'family_events' | 'week_plans_item'; id: string } | null;
  } = {},
): SentinelClassification {
  const {
    kind = 'booking_confirmation',
    teenContent = false,
    teenAttributed = false,
    sourceConfidence = 0.92,
    matchedEventRef = null,
    ...event
  } = over;
  return {
    status: 'classified',
    familyId: family.familyId,
    messageId: 'm1',
    extraction: {
      kind,
      event: {
        title: 'Swim Level 2',
        childRef: null,
        originalTime: null,
        newTime: FIRST_SESSION,
        location: 'the Leisure Centre',
        ...event,
      },
      sourceConfidence,
      quoteEvidence: "You're registered for Swim Level 2.",
      teenContent,
      teenAttributed,
      matchedEventRef,
    },
    usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
  };
}

interface Harness {
  ports: EmailAlertPorts;
  transport: FakeTransport;
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
}

function harness(
  over: {
    classification?: SentinelClassification;
    sendThrows?: TwilioSendError;
    /** The REAL correlation, over the REAL candidate loader, when the test is about
     * whether a class the family already holds is offered again. */
    correlate?: boolean;
    /** The outbound chokepoint says no — the branch that returns before every post-send
     * line, and the one a closer that runs only after a send would never reach. */
    gateHold?: ProactiveHoldReason;
    /** A BATCH: one verdict per message id, for the sweep tests where the order two
     * emails are read in is the whole question. */
    byMessage?: Record<string, SentinelClassification>;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const threaded: Harness['threaded'] = [];
  return {
    transport,
    threaded,
    ports: {
      classify: async (envelope) => {
        const base = over.byMessage?.[envelope.messageId] ?? over.classification ?? classified();
        if (!over.correlate || base.extraction === null) return base;
        const candidates = await loadCorrelationCandidates(db.database, family.familyId);
        return {
          ...base,
          extraction: {
            ...base.extraction,
            matchedEventRef: correlateExtraction(
              {
                kind: base.extraction.kind,
                title: base.extraction.event.title,
                originalTime: base.extraction.event.originalTime,
                newTime: base.extraction.event.newTime,
              },
              candidates,
            ),
          },
        };
      },
      gate: async () =>
        over.gateHold ? { allowed: false, reason: over.gateHold } : { allowed: true, optOut: 'full' },
      resolvePhone: async () => PHONE,
      transport: over.sendThrows
        ? {
            async send() {
              throw over.sendThrows;
            },
          }
        : transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
      timeZone: async () => 'America/Toronto',
    },
  };
}

function alert(h: Harness, messageId = 'm1', now = NOW) {
  return alertParentForEmail(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      messageId,
      envelope: ENVELOPE,
      cancelledThisSweep: new Set<string>(),
      timeZone: 'America/Toronto',
      now,
    },
    h.ports,
  );
}

function bookingRows() {
  return db.database
    .select()
    .from(schema.activityBookings)
    .where(eq(schema.activityBookings.familyId, family.familyId));
}

function offerRows() {
  return db.database
    .select()
    .from(schema.emailAlertOffers)
    .where(eq(schema.emailAlertOffers.familyId, family.familyId));
}

function auditRows() {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, family.familyId));
}

/** The one shape `bookingDraft` takes, with the clean confirmation as the baseline. */
const DRAFT_INPUT = {
  kind: 'booking_confirmation' as ExtractionKind,
  event: {
    title: 'Swim Level 2',
    childRef: null,
    originalTime: null,
    newTime: FIRST_SESSION,
    location: 'the Leisure Centre',
  },
  from: ENVELOPE.from,
  teenContent: false,
  teenAttributed: false,
  sourceConfidence: 0.92,
  matchedEventRef: null,
  title: 'Swim Level 2',
  location: 'the Leisure Centre',
  now: NOW,
};

describe('bookingDraft', () => {
  it('accepts a clean confirmation - the POSITIVE CONTROL for the six refusals below', () => {
    // Without this, six absence assertions pass on a function that refuses everything.
    expect(bookingDraft(DRAFT_INPUT)).toEqual({
      ok: true,
      draft: {
        providerHost: 'recreation.brookfield.example.ca',
        title: 'Swim Level 2',
        firstSessionAt: new Date(FIRST_SESSION),
        location: 'the Leisure Centre',
        eventId: null,
      },
    });
  });

  it('names each of the six refusals separately, never one bucket for all of them', () => {
    // A discriminated union rather than `| null`, so the cron summary can say WHICH floor
    // a confirmation fell at (rule #11).
    expect(bookingDraft({ ...DRAFT_INPUT, kind: 'new_event' })).toEqual({
      ok: false,
      reason: 'not_a_booking',
    });
    expect(bookingDraft({ ...DRAFT_INPUT, teenContent: true })).toEqual({
      ok: false,
      reason: 'teen_content',
    });
    // The DETERMINISTIC half of the same floor, and its own name: the model said nothing
    // and the child's date of birth said everything.
    expect(bookingDraft({ ...DRAFT_INPUT, teenAttributed: true })).toEqual({
      ok: false,
      reason: 'teen_attributed',
    });
    expect(
      bookingDraft({ ...DRAFT_INPUT, event: { ...DRAFT_INPUT.event, newTime: null } }),
    ).toEqual({ ok: false, reason: 'no_first_session' });
    expect(
      bookingDraft({
        ...DRAFT_INPUT,
        sourceConfidence: BOOKING_CONFIDENCE_FLOOR - 0.01,
      }),
    ).toEqual({ ok: false, reason: 'below_confidence' });
    // The renderer substitutes its OWN words when a vendor's title sanitises to nothing,
    // and those words are the object of a sentence, not the name of a class. Booking them
    // would have Hale ask "how did a spot go?" four days later - and the offer path has
    // already refused this same email on the same emptiness, so the row would outlive a
    // CTA that was never printed.
    expect(bookingDraft({ ...DRAFT_INPUT, title: '' })).toEqual({
      ok: false,
      reason: 'no_title',
    });
  });

  it('refuses a first session already in the past, and an unparseable one', () => {
    expect(
      bookingDraft({
        ...DRAFT_INPUT,
        event: { ...DRAFT_INPUT.event, newTime: '2026-09-01T13:00:00.000Z' },
      }),
    ).toEqual({ ok: false, reason: 'no_first_session' });
    expect(
      bookingDraft({ ...DRAFT_INPUT, event: { ...DRAFT_INPUT.event, newTime: 'next Saturday' } }),
    ).toEqual({ ok: false, reason: 'no_first_session' });
  });

  it('is stricter than the alert: 0.7 is the floor, and the alert still speaks at 0.6', () => {
    // The text may go out and be merely a text; a booking is a fact Hale acts on a week
    // later. The boundary itself, not a number near it.
    expect(BOOKING_CONFIDENCE_FLOOR).toBe(0.7);
    expect(bookingDraft({ ...DRAFT_INPUT, sourceConfidence: 0.7 }).ok).toBe(true);
    expect(bookingDraft({ ...DRAFT_INPUT, sourceConfidence: 0.6 })).toEqual({
      ok: false,
      reason: 'below_confidence',
    });
  });

  it('takes the bare domain and never the display name or the local part', () => {
    // The display name can carry a child's program name and the local part can be
    // `parent.name@`; the domain is the whole of what provenance needs.
    const draft = bookingDraft({
      ...DRAFT_INPUT,
      from: '"Swim Level 2 - Mia Chen" <mia.chen.parent@Recreation.Brookfield.Example.CA>',
    });
    expect(draft.ok && draft.draft.providerHost).toBe('recreation.brookfield.example.ca');
  });

  it('writes a family_events ref as event_id and a week_plans_item ref as nothing', () => {
    // The follow-up reader joins family_events; a week-plan id would not resolve there,
    // and a week-plan item is not a calendar row.
    const eventId = randomUUID();
    const matched = bookingDraft({
      ...DRAFT_INPUT,
      matchedEventRef: { table: 'family_events', id: eventId },
    });
    expect(matched.ok && matched.draft.eventId).toBe(eventId);

    const planned = bookingDraft({
      ...DRAFT_INPUT,
      matchedEventRef: { table: 'week_plans_item', id: randomUUID() },
    });
    expect(planned.ok && planned.draft.eventId).toBeNull();
  });
});

/**
 * THE TEEN FLOOR, driven through the REAL sentinel rather than a hand-written extraction.
 *
 * The defect this pins was not inside either gate — it was that the two were
 * COMPLEMENTARY. `resolveTeenContent` forces the model's flag from the child's age only
 * for an `unclear` kind or a sub-0.7 confidence; `bookingDraft` accepts only a
 * `booking_confirmation` at 0.7 or above. Exactly the region a booking lives in is the
 * region the age-based force never fires in, so a 14-year-old's confident receipt was
 * written down and asked about four days later — against this table's own doc, which says
 * a 13+ child's confirmation writes NO ROW AT ALL.
 *
 * A hand-written extraction with `teenContent: false` would hide that, because it is the
 * PIPELINE'S OWN ANSWER that is wrong. So the classification here comes from
 * `classifyChildEventEmail` with the real skills off disk and only the model's two answers
 * scripted (rule #8).
 */
describe('the teen floor (rule #1)', () => {
  const TEEN: FamilyChildRef = { id: 'child-teen', name: 'Maya', ageInMonths: 168 };
  const PRESCHOOLER: FamilyChildRef = { id: 'child-leo', name: 'Leo', ageInMonths: 60 };
  const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null };

  function scriptedClient(extraction: Record<string, unknown>): AgentClient {
    const create = vi.fn(async (params: { tools?: Array<{ name: string }> }) =>
      params.tools?.[0]?.name === 'triage'
        ? {
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'triage',
                input: {
                  child_related: true,
                  confidence: 0.95,
                  rationale: 'registration receipt',
                },
              },
            ],
            usage: USAGE,
          }
        : {
            content: [{ type: 'tool_use', id: 'e1', name: 'extraction', input: extraction }],
            usage: USAGE,
          },
    );
    return { messages: { create } } as unknown as AgentClient;
  }

  function sentinel(
    children: readonly FamilyChildRef[],
    over: { childRef: string | null; teenFlag?: boolean },
  ): Promise<SentinelClassification> {
    return classifyChildEventEmail(
      { familyId: family.familyId, messageId: 'm1', ...ENVELOPE },
      {
        client: scriptedClient({
          kind: 'booking_confirmation',
          event: {
            title: 'Swim Level 2',
            child_ref: over.childRef,
            original_time: null,
            new_time: FIRST_SESSION,
            location: 'the Leisure Centre',
          },
          source_confidence: 0.92,
          quote_evidence: "You're registered for Swim Level 2.",
          teen_content: over.teenFlag ?? false,
        }),
        children,
        fetchBody: async () => "You're registered for Swim Level 2.",
        correlationCandidates: [],
      },
    );
  }

  it('writes no row for a confident receipt attributed to a 14-year-old, though the model raised no flag', async () => {
    const classification = await sentinel([TEEN, PRESCHOOLER], { childRef: TEEN.id });
    // ON THE RECORD, because it is the whole reason the second gate has to exist: the
    // model-flag gate is SILENT here by design (the school/logistics carve-out), and a
    // confident booking_confirmation can never be `unclear` or below 0.7 and still reach
    // the booking floor. The date of birth is the only thing left that knows.
    expect(classification.extraction?.teenContent).toBe(false);
    expect(classification.extraction?.teenAttributed).toBe(true);

    const h = harness({ classification });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'teen_attributed' });
    await expect(bookingRows()).resolves.toEqual([]);
  });

  it("still refuses on the model's own flag, with no child attributed at all", async () => {
    // The existing gate, unweakened: `teen_content` keeps its exact name and its exact
    // trigger, and the new one is an OR beside it rather than a replacement.
    const classification = await sentinel([TEEN], { childRef: null, teenFlag: true });
    expect(classification.extraction?.teenContent).toBe(true);
    expect(classification.extraction?.teenAttributed).toBe(false);

    const h = harness({ classification });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'teen_content' });
    await expect(bookingRows()).resolves.toEqual([]);
  });

  it('books the five-year-old - the POSITIVE CONTROL both refusals need', async () => {
    const classification = await sentinel([TEEN, PRESCHOOLER], { childRef: PRESCHOOLER.id });
    expect(classification.extraction?.teenAttributed).toBe(false);

    const h = harness({ classification });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'recorded' });
    await expect(bookingRows()).resolves.toHaveLength(1);
  });

  it('books a receipt naming no child at all - the residual, asserted rather than assumed', async () => {
    // Most municipal receipts name nobody. If the new gate had been written on "a teen is
    // in this household" rather than "this receipt is about the teen", this is the case it
    // would have silently taken down with it.
    const classification = await sentinel([TEEN], { childRef: null });
    expect(classification.extraction?.teenAttributed).toBe(false);

    const h = harness({ classification });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'recorded' });
    await expect(bookingRows()).resolves.toHaveLength(1);
  });
});

/**
 * THE CANCELLATION CLOSER — the provider says the class is off, so Hale stops holding it.
 *
 * Without this the branch shipped a booking that nothing could ever close: four days after
 * a class the provider cancelled, the follow-up asks "how did it go?" about something that
 * never happened, and the parent was told about the cancellation in the same breath.
 *
 * IT RUNS BEFORE THE GATE, on purpose. A hold returns before every post-send line, and the
 * Gmail cursor has already advanced past this message — so a closer that ran only after a
 * send would leave the 23:40 cancellation permanently unread. The quiet-hours case below IS
 * the test of that placement.
 */
describe('a provider cancellation closes what it cancelled', () => {
  /** The receipt that put the booking in the table. */
  async function booked(messageId = 'm1') {
    await expect(alert(harness(), messageId)).resolves.toEqual({
      alert: 'sent',
      booking: 'recorded',
    });
  }

  function cancellation(title: string, gateHold?: ProactiveHoldReason) {
    return harness({
      classification: classified({
        kind: 'cancellation',
        title,
        newTime: null,
        originalTime: FIRST_SESSION,
      }),
      gateHold,
    });
  }

  it('stamps the booking at 23:40, when the text itself was held', async () => {
    await booked();
    // The vendor's second email spells the class differently. One normaliser — casefold,
    // collapse whitespace, trim — and nothing else: no instant equality (a cancellation
    // rarely repeats the time), no location, no fuzzy match.
    const h = cancellation('  swim   LEVEL 2 ', 'quiet_hours');
    await expect(alert(h, 'm2')).resolves.toEqual({
      alert: 'gate_refused:quiet_hours',
      booking: null,
    });
    expect(h.transport.sent).toEqual([]);

    const rows = await bookingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cancelledAt).toEqual(NOW);

    const closed = (await auditRows()).filter(
      (row) => row.actionTaken === 'activity_booking_cancelled',
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      targetTable: 'activity_bookings',
      targetId: rows[0]?.id,
    });
    // EXACTLY one flag, and `toEqual` rather than `toMatchObject` on purpose: the whole
    // rule for this row is that it carries nothing of the email, and a subset match would
    // pass with the provider's domain sitting beside it.
    expect(closed[0]?.after).toEqual({ offerWithdrawn: true });
  });

  it('takes the closed booking out of the follow-up reader', async () => {
    await booked();
    const window = {
      floor: new Date('2026-09-21T13:00:00.000Z'),
      latest: new Date('2026-09-27T13:00:00.000Z'),
    };
    // The positive control FIRST: without it, the assertion below passes on a reader that
    // returns nothing for any reason at all.
    await expect(readDueBookings(db.database, family.familyId, window)).resolves.toHaveLength(1);

    await alert(cancellation('Swim Level 2'), 'm2');
    await expect(readDueBookings(db.database, family.familyId, window)).resolves.toEqual([]);
  });

  it('takes the standing calendar offer down with it', async () => {
    // THE LATE YES. The offer stands for 24 hours; the cancellation arrives in hour three.
    // Without this, a parent who reads their texts at bedtime says YES to the morning's
    // "Want it on your calendar?" and Hale places - and then reminds twice about, and puts
    // in the week plan - a class its OWN text said was called off. The offer is the last
    // live path from a cancelled booking to the family's calendar.
    //
    // WITHDRAWN BY ITS EXPIRY, which is the column's own contract ("when the offer stops
    // being answerable", applied at the one reader) rather than a resolution: nothing was
    // added and nothing was declined, the parent never answered at all, and the CHECK on
    // that table makes half a resolution unwritable for exactly that reason.
    await booked();
    await expect(offerRows()).resolves.toHaveLength(1);

    await alert(cancellation('Swim Level 2'), 'm2');

    const later = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    await expect(
      loadOpenEmailAlertOffers(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        now: later,
      }),
    ).resolves.toEqual([]);

    // ...and the bare YES therefore has nothing to place.
    await expect(
      handleEmailAlertOfferReply(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        offerId: null,
        polarity: 'yes',
        language: 'en',
        now: later,
      }),
    ).resolves.toEqual({ status: 'no_open_offer' });
    await expect(
      db.database
        .select()
        .from(schema.familyEvents)
        .where(eq(schema.familyEvents.familyId, family.familyId)),
    ).resolves.toEqual([]);

    // The trail says the offer went with it: one flag, on the row that already records
    // the closing.
    const closed = (await auditRows()).filter(
      (row) => row.actionTaken === 'activity_booking_cancelled',
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.after).toEqual({ offerWithdrawn: true });
  });

  it("leaves the OTHER class's offer standing", async () => {
    // THE POSITIVE CONTROL, and it is about the KEY. A household holds two classes from
    // one provider; one is called off. Without this, the assertion above passes on a
    // closer that withdraws every open offer this parent has — which would silently eat
    // the calendar question for a class that is still going ahead.
    await booked();
    const second = harness({ classification: classified({ title: 'Skating Level 1' }) });
    await expect(alert(second, 'm2')).resolves.toEqual({ alert: 'sent', booking: 'recorded' });
    await expect(offerRows()).resolves.toHaveLength(2);

    await alert(cancellation('Swim Level 2'), 'm3');

    const later = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    const open = await loadOpenEmailAlertOffers(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      now: later,
    });
    expect(open.map((offer) => offer.title)).toEqual(['Skating Level 1']);
  });

  it('leaves a different class from the same provider alone', async () => {
    await booked();
    await alert(cancellation('Skating Level 1'), 'm2');
    await expect(bookingRows().then((r) => r[0]?.cancelledAt)).resolves.toBeNull();
  });

  it('leaves a session that already happened alone', async () => {
    // Closing a past booking would erase a class the family actually went to, and take its
    // "how did it go?" down with it. The closer is about the FUTURE the family still holds.
    await booked();
    await db.database
      .update(schema.activityBookings)
      .set({ firstSessionAt: new Date('2026-09-10T13:00:00.000Z') })
      .where(eq(schema.activityBookings.familyId, family.familyId));

    await alert(cancellation('Swim Level 2'), 'm2');
    await expect(bookingRows().then((r) => r[0]?.cancelledAt)).resolves.toBeNull();
  });

  it('changes nothing on a second cancellation of the same class', async () => {
    await booked();
    await alert(cancellation('Swim Level 2'), 'm2');
    const later = new Date('2026-09-17T16:00:00.000Z');
    await alert(cancellation('Swim Level 2'), 'm3', later);

    // The first stamp stands, and the trail records one closing rather than two: a second
    // audit row would be a second claim about the same fact (rule #6).
    await expect(bookingRows().then((r) => r[0]?.cancelledAt)).resolves.toEqual(NOW);
    expect(
      (await auditRows()).filter((row) => row.actionTaken === 'activity_booking_cancelled'),
    ).toHaveLength(1);
  });
});

/**
 * ONE SWEEP, TWO EMAILS, AND THE ORDER IS BACKWARDS.
 *
 * A batch is read NEWEST FIRST, because when a mailbox has just taken sixty messages the
 * ones worth a text are the ones that arrived last. That is right for what may be SPENT
 * and exactly wrong for a cancellation: the provider's "CANCELLED" is newer than the
 * receipt it cancels, so inside ONE sweep the closer runs first, finds nothing — the
 * booking does not exist yet — and the receipt is then read, texted as "you're in",
 * offered, and written down live. Hale tells a parent they are in a class it told them was
 * off ninety seconds earlier, and asks how it went four days later.
 *
 * So the sweep REMEMBERS what it has already been told is off, and a receipt whose provider
 * and class are in that set is not spoken about at all: no text, no CTA, no offer row, no
 * booking. Not merely "no booking" — a "you're in" with no calendar question behind it
 * would still be Hale contradicting itself on the same phone in the same minute.
 *
 * It is sound ONLY because of the sort: everything read after a cancellation is older than
 * it. The mirror — a re-registration NEWER than the cancellation, read first and then
 * closed by it — is named in the commit and is a missing question rather than a wrong one.
 */
describe('a cancellation the same sweep has already read', () => {
  const RECEIPT = { ...ENVELOPE, messageId: 'm-receipt', receivedAt: '2026-09-17T14:00:00.000Z' };
  const CANCELLED = {
    ...ENVELOPE,
    messageId: 'm-cancelled',
    subject: 'CANCELLED - Swim Level 2',
    snippet: 'Swim Level 2 on Sep 26 has been cancelled.',
    receivedAt: '2026-09-17T14:30:00.000Z',
  };

  function batch(cancelledTitle: string): Harness {
    return harness({
      byMessage: {
        'm-receipt': classified(),
        'm-cancelled': classified({
          kind: 'cancellation',
          title: cancelledTitle,
          newTime: null,
          originalTime: FIRST_SESSION,
        }),
      },
    });
  }

  function sweep(h: Harness) {
    return alertParentForGmailSweep(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: INTEGRATION,
        seeding: false,
        // Handed in the order they sit in the mailbox; the sweep is what reverses them.
        envelopes: [RECEIPT, CANCELLED],
        now: NOW,
      },
      h.ports,
    );
  }

  it('says nothing at all about the receipt for the class it just called off', async () => {
    const h = batch('Swim Level 2');

    await expect(sweep(h)).resolves.toEqual([
      // Newest first: the cancellation is read BEFORE the receipt it cancels.
      { alert: 'sent', booking: 'not_a_booking' },
      { alert: 'cancelled_in_sweep', booking: null },
    ]);

    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.body).not.toContain("you're in");
    await expect(bookingRows()).resolves.toEqual([]);
    await expect(offerRows()).resolves.toEqual([]);
  });

  it('still speaks about a receipt the cancellation does not name', async () => {
    // THE POSITIVE CONTROL. Without it the assertion above passes on a sweep that stopped
    // sending anything after a cancellation, which is a different and worse feature.
    const h = batch('Skating Level 1');

    await expect(sweep(h)).resolves.toEqual([
      { alert: 'sent', booking: 'not_a_booking' },
      { alert: 'sent', booking: 'recorded' },
    ]);
    expect(h.transport.sent).toHaveLength(2);
    await expect(bookingRows()).resolves.toHaveLength(1);
  });

  it('suppresses nothing when booked detection is dark', async () => {
    // The flag gates this too, and it must: dark, a `booking_confirmation` IS a
    // `new_event` in every respect, and a new_event was never suppressed by a
    // cancellation. Flag-off behaviour stays byte-identical to today's.
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'false');
    const h = batch('Swim Level 2');

    await expect(sweep(h)).resolves.toEqual([
      { alert: 'sent', booking: 'booked_dark' },
      { alert: 'sent', booking: 'booked_dark' },
    ]);
    expect(h.transport.sent).toHaveLength(2);
  });
});

describe('the booking write', () => {
  it('writes one row after the send, with the audit row carrying ONLY { offered: true }', async () => {
    const h = harness();
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'recorded' });

    const rows = await bookingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      messageId: 'm1',
      providerHost: 'recreation.brookfield.example.ca',
      title: 'Swim Level 2',
      firstSessionAt: new Date(FIRST_SESSION),
      location: 'the Leisure Centre',
      eventId: null,
    });

    const audit = await auditRows();
    const booking = audit.find((row) => row.actionTaken === 'activity_booking_recorded');
    expect(booking).toMatchObject({
      targetTable: 'activity_bookings',
      targetId: rows[0]?.id,
    });
    // EXACTLY this object. `provider_host` is the SENDER, and this module's own rule for
    // `after` is enums and flags only - not the title, NOT the sender, not the subject -
    // because an audit row a support agent can read is a copy of the email in a table
    // that is never redacted. MUTATION: add providerHost (or title, or firstSessionAt)
    // to the `after` and this goes red.
    expect(booking?.after).toEqual({ offered: true });
  });

  it('is written AFTER the send: a refused transport leaves no booking and no offer', async () => {
    const h = harness({ sendThrows: new TwilioSendError('21610', 400) });
    await expect(alert(h)).resolves.toEqual({ alert: 'send_failed', booking: null });

    // MUTATION: move the write above `ports.transport.send` and both of these go red.
    await expect(bookingRows()).resolves.toHaveLength(0);
    await expect(offerRows()).resolves.toHaveLength(0);
  });

  it('writes NO row for a receipt whose class has no name, and still sends the text', async () => {
    // `Reminder:` is a vendor label and nothing else, so `sanitizedTitle` leaves nothing
    // behind it. The text goes out in Hale's own words; the row does not exist to be
    // asked about.
    const h = harness({ classification: classified({ title: 'Reminder:' }) });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'no_title' });

    await expect(bookingRows()).resolves.toHaveLength(0);
    await expect(offerRows()).resolves.toHaveLength(0);
    expect(h.transport.sent).toHaveLength(1);
    // No row behind it, so no question in front of it.
    expect(h.transport.sent[0]?.body).not.toContain('?');
  });

  it("folds the row's place through the same one function the offer row uses", async () => {
    // The brief's rule for this row is that its strings go through the fold the wire uses:
    // they reach a parent later, in a reminder. Asserted as an EQUALITY with the offer row
    // rather than against a hand-copied expectation, so the two can never drift apart.
    const h = harness({
      classification: classified({
        location:
          'the \u201cRiverside\u201d Leisure Centre \u2014 Pool 2, 1200 Lakeshore Road West, Brookfield',
      }),
    });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'recorded' });

    const [booking] = await bookingRows();
    const [offer] = await offerRows();
    expect(booking?.location).toBe(offer?.location);
    expect((booking?.location ?? '').length).toBeLessThanOrEqual(60);
  });

  it('is idempotent on (connection, message): a re-fired sweep records nothing twice', async () => {
    const draft = bookingDraft(DRAFT_INPUT);
    if (!draft.ok) throw new Error('fixture lost its draft');
    const channelMessageId = await sentAlertRow();

    const first = await recordActivityBooking(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      messageId: 'm1',
      channelMessageId,
      draft: draft.draft,
    });
    expect(first.outcome).toBe('recorded');

    const second = await recordActivityBooking(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      messageId: 'm1',
      channelMessageId,
      draft: { ...draft.draft, title: 'A DIFFERENT TITLE' },
    });
    expect(second).toEqual({ outcome: 'already_recorded', bookingId: null });

    const rows = await bookingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Swim Level 2');
  });

  it('writes NO row for a 13+ child, and the same email for a 5-year-old DOES write one', async () => {
    // The positive control is the test. A 13+ child's title has already been genericised
    // by the pipeline, so recording it would let a follow-up ask about a teen's activity
    // four days later on the strength of a title Hale deliberately erased (rule #1).
    const teen = harness({ classification: classified({ teenContent: true }) });
    await expect(alert(teen)).resolves.toEqual({ alert: 'sent', booking: 'teen_content' });
    await expect(bookingRows()).resolves.toHaveLength(0);

    const young = harness();
    await expect(alert(young, 'm2')).resolves.toEqual({ alert: 'sent', booking: 'recorded' });
    await expect(bookingRows()).resolves.toHaveLength(1);
  });

  it('records booked_dark with the flag off, and the text is the new_event one', async () => {
    // 'true\n' is what `vercel env add` from a piped echo stores, and a truthiness check
    // would read it as ON.
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true\n');
    const h = harness();
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'booked_dark' });
    await expect(bookingRows()).resolves.toHaveLength(0);
    expect(h.transport.sent[0]?.body).toContain('Reply YES and it goes on your week.');
    expect(h.transport.sent[0]?.body).not.toContain('Want it on your calendar?');
  });

  it('counts a booking that never reached the decision as null, not as a refusal', async () => {
    // "the alert never got that far" and "the booking was refused" are two facts, and a
    // bucket that means both is the counter rule #11 exists to prevent.
    vi.stubEnv('F14_ENABLED', 'false');
    await expect(alert(harness())).resolves.toEqual({ alert: 'dark', booking: null });
  });
});

describe('record_failed', () => {
  it('still threads and still audits: the text went out, and the receipts for it must too', async () => {
    // Rev 1 put the write inside the sweep's `alert_failed` boundary, which made this
    // outcome unreachable AND skipped the thread and the alert's own audit - leaving a
    // parent's thread the coach reads a reply to with nothing above it.
    const h = harness();
    // A PROXY and not a spread: the Drizzle handle's methods live on its prototype, so
    // `{ ...db.database }` loses `select` and the run dies before the send.
    const broken = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === schema.activityBookings) throw new Error('booking insert exploded');
            return target.insert(table as Parameters<typeof target.insert>[0]);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      alertParentForEmail(
        broken,
        {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          integrationId: INTEGRATION,
          messageId: 'm1',
          envelope: ENVELOPE,
          cancelledThisSweep: new Set<string>(),
          timeZone: 'America/Toronto',
          now: NOW,
        },
        h.ports,
      ),
    ).resolves.toEqual({ alert: 'sent', booking: 'record_failed' });

    await expect(bookingRows()).resolves.toHaveLength(0);
    expect(h.threaded).toHaveLength(1);
    const audit = await auditRows();
    expect(audit.filter((row) => row.actionTaken === 'email_alert_sent')).toHaveLength(1);
    expect(audit.filter((row) => row.actionTaken === 'activity_booking_recorded')).toHaveLength(0);
  });
  it('is the BOOKING write and never the audit: a row that exists is never reported as missing', async () => {
    // `record_failed` says, in its own definition, "the text went, the row did not", and
    // the console line says the ask will not happen. Both are lies if what threw was the
    // audit insert AFTER the row landed - the ask WILL happen, off a booking the summary
    // counted as absent. So the audit sits outside the booking's catch and a failure
    // there propagates, exactly as the alert's own audit row already does.
    const brokenAudit = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (table: unknown) => {
          const builder = target.insert(table as Parameters<typeof target.insert>[0]);
          if (table !== schema.auditLog) return builder;
          return new Proxy(builder, {
            get(inner, key, innerReceiver) {
              if (key !== 'values') return Reflect.get(inner, key, innerReceiver);
              return (row: { actionTaken?: string }) => {
                if (row.actionTaken === 'activity_booking_recorded') {
                  throw new Error('audit insert exploded');
                }
                return (inner as typeof builder).values(
                  row as Parameters<typeof builder.values>[0],
                );
              };
            },
          });
        };
      },
    });

    const h = harness();
    await expect(
      alertParentForEmail(
        brokenAudit,
        {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          integrationId: INTEGRATION,
          messageId: 'm1',
          envelope: ENVELOPE,
          cancelledThisSweep: new Set<string>(),
          timeZone: 'America/Toronto',
          now: NOW,
        },
        h.ports,
      ),
    ).rejects.toThrow('audit insert exploded');

    // THE FAR-SIDE ARTIFACT: the row is there. Reporting `record_failed` here would have
    // been a counter saying the opposite of the table.
    await expect(bookingRows()).resolves.toHaveLength(1);
  });
});

describe('the offer that must not be made twice', () => {
  it('makes NO offer for a class already on the calendar, and stamps the booking with it', async () => {
    // Through the REAL `loadCorrelationCandidates` and the REAL `correlateExtraction`:
    // the family said YES to the September announcement two weeks ago, the receipt
    // arrives now, and a second offer would place a second copy of one Saturday.
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: family.familyId,
        title: 'Swim lessons',
        startsAt: new Date(FIRST_SESSION),
        source: 'parent',
      })
      .returning({ id: schema.familyEvents.id });
    if (!event) throw new Error('fixture lost its event');

    const h = harness({ correlate: true });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'recorded' });

    // No question, because no row would have been behind it.
    expect(h.transport.sent[0]?.body).not.toContain('?');
    await expect(offerRows()).resolves.toHaveLength(0);
    const rows = await bookingRows();
    expect(rows[0]?.eventId).toBe(event.id);
  });

  it('DOES offer a genuinely new class - the positive control for the suppression above', async () => {
    // Same path, same loader, nothing on the calendar: the offer this ticket exists to
    // make still gets made. This is the direction the `loadCorrelationCandidates`
    // mutation breaks - widen that loader to include watched spots and a family's own
    // watch suppresses the offer it was watching FOR.
    await db.database.insert(schema.watchedSpots).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      label: 'Swim Level 2',
      sourceUrl: 'https://recreation.brookfield.example.ca/course/swim-level-2',
      createdFrom: 'test',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });

    const h = harness({ correlate: true });
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'recorded' });

    expect(h.transport.sent[0]?.body).toContain('Want it on your calendar?');
    await expect(offerRows()).resolves.toHaveLength(1);
    const rows = await bookingRows();
    expect(rows[0]?.eventId).toBeNull();
  });
});

describe('stampBookingEvent', () => {
  it("stamps the placed event onto the booking born from the same email, once", async () => {
    const h = harness();
    await expect(alert(h)).resolves.toEqual({ alert: 'sent', booking: 'recorded' });
    const eventId = randomUUID();

    await expect(
      stampBookingEvent(db.database, { integrationId: INTEGRATION, messageId: 'm1', eventId }),
    ).resolves.toBe('stamped');
    await expect(bookingRows().then((r) => r[0]?.eventId)).resolves.toBe(eventId);

    // A NO leaves it alone: there is no second call, and the booking stays alive either
    // way — the parent went to the class whatever they wanted on their calendar.
    await expect(
      stampBookingEvent(db.database, {
        integrationId: INTEGRATION,
        messageId: 'never-seen',
        eventId: randomUUID(),
      }),
    ).resolves.toBe('no_booking');
    await expect(bookingRows()).resolves.toHaveLength(1);
  });
});

describe('readDueBookings', () => {
  const WINDOW = {
    floor: new Date('2026-09-21T13:00:00.000Z'),
    latest: new Date('2026-09-27T13:00:00.000Z'),
  };

  async function seedBooking(over: { firstSessionAt?: Date; eventId?: string | null } = {}) {
    const channelMessageId = await sentAlertRow();
    const [row] = await db.database
      .insert(schema.activityBookings)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: INTEGRATION,
        messageId: randomUUID(),
        providerHost: 'recreation.brookfield.example.ca',
        title: 'Swim Level 2',
        firstSessionAt: over.firstSessionAt ?? new Date(FIRST_SESSION),
        eventId: over.eventId ?? null,
        channelMessageId,
      })
      .returning({ id: schema.activityBookings.id });
    if (!row) throw new Error('seedBooking: insert returned no row');
    return row.id;
  }

  async function seedEvent(source: 'placement' | 'parent') {
    const [row] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: family.familyId,
        title: 'Swim Level 2',
        startsAt: new Date(FIRST_SESSION),
        source,
      })
      .returning({ id: schema.familyEvents.id });
    if (!row) throw new Error('seedEvent: insert returned no row');
    return row.id;
  }

  it('returns an unmatched booking inside the window, and nothing outside it', async () => {
    const inside = await seedBooking();
    await seedBooking({ firstSessionAt: new Date('2026-10-20T13:00:00.000Z') });

    const due = await readDueBookings(db.database, family.familyId, WINDOW);
    expect(due.map((row) => row.bookingId)).toEqual([inside]);
    expect(due[0]).toMatchObject({
      parentUserId: family.parentUserId,
      title: 'Swim Level 2',
      firstSessionAt: new Date(FIRST_SESSION),
    });
  });

  it('defers to the placement reader, and only for a placement', async () => {
    // BOTH branches, because the naive `event_id IS NOT NULL` exclusion passes the first
    // and silently drops the second: a booking whose YES placed a source='parent' row is
    // INVISIBLE to `readDueActivities`, which filters source='placement'.
    await seedBooking({ eventId: await seedEvent('placement') });
    const parentPlaced = await seedBooking({ eventId: await seedEvent('parent') });

    const due = await readDueBookings(db.database, family.familyId, WINDOW);
    expect(due.map((row) => row.bookingId)).toEqual([parentPlaced]);
  });

  it('never reaches another family', async () => {
    await seedBooking();
    const other = await seedFamily(db.database, 'Other Family');
    await expect(readDueBookings(db.database, other.familyId, WINDOW)).resolves.toEqual([]);
  });
});

/** The outbound row an alert would have claimed — NOT NULL on the booking, so every row
 * seeded here hangs off a text that actually went out. */
async function sentAlertRow(): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: 'connector:email_alert',
      status: 'queued',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('sentAlertRow: insert returned no row');
  return row.id;
}
