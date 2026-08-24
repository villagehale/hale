import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type NudgeRunDeps, defaultNudgeRunDeps, runNudgeCron } from '~/lib/channel/nudge/run';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { introAskDedupeKey } from '~/lib/village/intros/run';
import type { ChannelCoachRuntime } from '~/lib/channel/router/coach-runtime';
import { checkupDraftedReply, conflictReply } from '~/lib/channel/router/copy';
import { channelRouterDeps, defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { healthReplyHandler } from '~/lib/channel/router/handlers';
import { defaultHealthReplyDeps } from '~/lib/health/reply';
import type { ChannelRouterDeps } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import { type ReplyResolver, toReading } from '~/lib/channel/router/resolve';
import { checkpointById, checkpointRef } from '~/lib/health/checkpoints';
import { HEALTH_CLOSE_BOOKING } from '~/lib/health/copy';
import { checkpointToldKey } from '~/lib/health/told';
import { CHECKUP_OFFER_TTL_HOURS } from '~/lib/health/offer';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeWeather } from '~/lib/weather/open-meteo';

/**
 * THE OFFER IS A PROPOSAL — the 2026-08-20 transcript, replayed end to end.
 *
 * WHAT HAPPENED. At 10:00 Hale texted a parent the 18-month well-baby checkpoint, which
 * ends by ASKING: "Done, or want me to add booking it to your week?" At 14:20 they
 * accepted. What came back was "Which one - add to your calendar or meeting the family
 * nearby?" — two standing questions that were not the one they were answering — and then,
 * when they said which, "That one hasn't cleared my own checks."
 *
 * WHY. The offer had no row. Every other question Hale holds is a row somebody wrote
 * (a drafted action, a proposal, a plan-offer commitment) and the reply resolver reads
 * those rows; this one existed only as a sentence inside a sent SMS. So the acceptance
 * was read against everything EXCEPT the thing it answered.
 *
 * WHAT THIS PINS. The nudge writes the offer down at send time, the acceptance resolves
 * to it, and the draft the offer promised is a real row held for approval — through the
 * REAL sweep, the REAL open-question reader, the REAL handler chain and the REAL ledger,
 * over real Postgres. The two seams that are Fakes are the two that leave the building:
 * the SMS transport, and the model's words (rule #8 — the resolver's PICK is proven on
 * cached Claude in apps/worker/evals/reply-resolver-fixtures.mjs, and what runs here is
 * the real `toReading` over the raw shape that eval records).
 *
 * The mutation at the bottom is the point of the whole file: delete the send-time
 * registration and the parent's acceptance finds nothing again.
 */

const TZ = 'America/Toronto';
const AREA = 'M4K';
const PHONE = '+14165550100';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

/** 10:00 Toronto — this family's nudge slot. */
const NUDGE_AT = new Date('2026-08-20T14:00:00.000Z');
/** 14:20 Toronto, the same afternoon: the acceptance. */
const REPLY_AT = new Date('2026-08-20T18:20:00.000Z');

/** 19 months at the sweep: inside the 18-23 month well-baby band, which is the one
 * Ontario row whose task IS booking a visit. */
const CHILD_DOB = '2025-01-15';

describe('the offer is a proposal', () => {
  let db: TestDb;
  let database: Database;
  let familyId: string;
  let parentUserId: string;
  let childId: string;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);

    const [family] = await database
      .insert(schema.families)
      .values({
        displayName: 'Reyes family',
        provinceOrState: 'ON',
        areaCoarse: AREA,
        onboardingStage: 'sms_active',
      })
      .returning({ id: schema.families.id });
    familyId = (family as { id: string }).id;

    const [user] = await database
      .insert(schema.users)
      .values({ email: null, name: null, timezone: TZ })
      .returning({ id: schema.users.id });
    parentUserId = (user as { id: string }).id;

    await database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentUserId, role: 'primary_parent' });
    await database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: `hash-${parentUserId}`,
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    const [child] = await database
      .insert(schema.children)
      .values({ familyId, name: 'Ines', dateOfBirth: CHILD_DOB })
      .returning({ id: schema.children.id });
    childId = (child as { id: string }).id;

    // Ontario has TWO rows for an 18-month-old and they share a band: the routine
    // vaccine visit and the longer well-baby visit. Only the second's task IS booking,
    // and this family has already been told the first — which is what makes the
    // well-baby row the one the sweep raises, and this journey about an OFFER rather
    // than about the matcher's tie-break.
    const vaccineRow = checkpointById('immunization_18_months');
    if (!vaccineRow) throw new Error('fixture drift: no immunization_18_months');
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      templateKey: 'proactive_nudge:health_checkpoint',
      dedupeKey: checkpointToldKey(familyId, checkpointRef(vaccineRow, childId, 0)),
      status: 'delivered',
      sentAt: new Date('2026-08-06T14:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  /** Consent, enrolment and volume are settled elsewhere; this journey is about what a
   * send WRITES DOWN, not about whether it is allowed. */
  const openGate: OutboundGatePorts = {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    proactiveSentSince: async () => true,
    parentTimeZone: async () => TZ,
  };

  function nudgeDeps(transport: FakeTransport, overrides: Partial<NudgeRunDeps> = {}) {
    return {
      ...defaultNudgeRunDeps(),
      // SEAM: prod selects families ⋈ family_members ⋈ users. Which families are DUE is
      // not what this journey is about; what the send writes down is.
      selectFamilies: async () => [
        {
          familyId,
          parentUserId,
          areaCoarse: AREA,
          timeZone: TZ,
          provisionedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
      buildGate: () => openGate,
      resolveSendablePhone: async () => PHONE,
      weather: fakeWeather([]),
      transport,
      client: null,
      ...overrides,
    } satisfies NudgeRunDeps;
  }

  /** The nudge that makes the offer, sent for real over a fake wire. */
  async function sendTheNudge(overrides: Partial<NudgeRunDeps> = {}): Promise<FakeTransport> {
    const transport = new FakeTransport();
    const result = await runNudgeCron(database, nudgeDeps(transport, overrides), NUDGE_AT);
    expect(result.sent).toBe(1);
    return transport;
  }

  /**
   * The two OTHER things Hale was holding that afternoon, exactly as production held
   * them: a calendar draft its own reviewer had flagged, and the introductions ask.
   */
  async function seedTheOtherQuestions(): Promise<string> {
    const [event] = await database
      .insert(schema.events)
      .values({
        familyId,
        source: 'channel_sms',
        eventType: 'channel_sms.calendar_intent',
        dedupHash: 'journey-swim-lessons',
      })
      .returning({ id: schema.events.id });
    const [action] = await database
      .insert(schema.actions)
      .values({
        familyId,
        eventId: (event as { id: string }).id,
        actionType: 'calendar_add',
        payload: { title: 'Swim lessons', date: '2026-08-22' },
        userVisibleState: 'drafted_for_approval',
        reviewerVerdict: 'flagged',
        draftedAt: new Date('2026-08-20T09:07:06.000Z'),
      })
      .returning({ id: schema.actions.id });

    // The discoverability ask is an ABSENCE — a delivered ask with no consent row behind
    // it — so one outbound row with its dedupe key is the whole question.
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      templateKey: 'village_intro:discoverability_ask',
      dedupeKey: introAskDedupeKey(familyId),
      status: 'delivered',
      sentAt: new Date('2026-08-13T12:00:00.000Z'),
    });

    return (action as { id: string }).id;
  }

  async function openQuestions(now: Date) {
    return defaultOpenQuestionReader().open(database, { familyId, parentUserId, now });
  }

  async function inboundText(body: string, at: Date, n: number): Promise<string> {
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId: `SM-in-${n}`,
        status: 'delivered',
        body,
        sentAt: at,
      })
      .returning({ id: schema.channelMessages.id });
    return (row as { id: string }).id;
  }

  /**
   * The resolver, post-processing a RECORDED model answer through the real `toReading`.
   *
   * Not a fake verdict: `toReading` is where the id is checked against the offered set,
   * where the grade is applied, and where a polarity this question has nowhere to put is
   * refused — which is the decision the 2026-08-20 transcript turned on. The model's own
   * pick is the eval's job (rule #8).
   */
  function recordedResolver(
    raw: { target: string; polarity: string; confidence: string },
  ): ReplyResolver {
    return { read: async ({ questions }) => toReading(raw, questions) };
  }

  function fakeCoach(reply: string): ChannelCoachRuntime & { standingQuestions: string[][] } {
    const coach = {
      standingQuestions: [] as string[][],
      async respond(turn: { standingQuestions: readonly string[] }) {
        coach.standingQuestions.push([...turn.standingQuestions]);
        return { reply, planOffer: null, activityPromise: null };
      },
    };
    return coach as ChannelCoachRuntime & { standingQuestions: string[][] };
  }

  function routerDeps(
    transport: FakeTransport,
    resolver: ReplyResolver,
    coach: ChannelCoachRuntime,
    now: Date,
  ): ChannelRouterDeps {
    return {
      ...channelRouterDeps(database),
      // The chain, with M8's drafter swapped for one that writes the SAME row without
      // the drafter/reviewer model call. What this journey is about is whether an
      // acceptance reaches a draft at all; what the reviewer then says about that draft
      // is the approval engine's own business, tested where it lives.
      handlers: channelRouterDeps(database).handlers.map((handler) =>
        handler.name === 'health'
          ? healthReplyHandler({ ...defaultHealthReplyDeps(), draftCheckup })
          : handler,
      ),
      transport,
      replyResolver: resolver,
      coach,
      // The off-domain screen is a model call this journey never needs to make: every
      // message below is plainly about this family's own week.
      offDomain: { consider: async () => ({ status: 'in_domain' as const, fallback: null }) },
      limiter: new FakeRateLimiter(),
      now: () => now,
      log: { info: () => {}, error: () => {} },
    };
  }

  /** The approvals-engine row a `book_checkup` acceptance mints, minus the model. */
  const draftCheckup: NonNullable<ReturnType<typeof defaultHealthReplyDeps>['draftCheckup']> =
    async (_database, input) => {
      const [event] = await database
        .insert(schema.events)
        .values({
          familyId: input.familyId,
          source: 'ask_hale',
          eventType: 'ask_hale.action_intent',
          dedupHash: `journey-${input.intentKind}`,
        })
        .returning({ id: schema.events.id });
      const [action] = await database
        .insert(schema.actions)
        .values({
          familyId: input.familyId,
          eventId: (event as { id: string }).id,
          actionType: 'book_checkup',
          payload: { title: input.sourceAnswer, childId: input.childId },
          userVisibleState: 'drafted_for_approval',
          draftedAt: REPLY_AT,
        })
        .returning({ id: schema.actions.id });
      return { actionId: (action as { id: string }).id };
    };

  async function drafts(actionType: string) {
    return database
      .select({
        id: schema.actions.id,
        state: schema.actions.userVisibleState,
        payload: schema.actions.payload,
      })
      .from(schema.actions)
      .where(and(eq(schema.actions.familyId, familyId), eq(schema.actions.actionType, actionType)));
  }

  async function offerRows() {
    return database
      .select({
        id: schema.agentCommitments.id,
        topic: schema.agentCommitments.topic,
        subjectChildId: schema.agentCommitments.subjectChildId,
        dueAt: schema.agentCommitments.dueAt,
        fulfilledAt: schema.agentCommitments.fulfilledAt,
        createdFrom: schema.agentCommitments.createdFrom,
      })
      .from(schema.agentCommitments)
      .where(
        and(
          eq(schema.agentCommitments.familyId, familyId),
          eq(schema.agentCommitments.commitmentKind, 'checkup_offer'),
        ),
      );
  }

  it('registers the offer against the message that made it', async () => {
    const transport = await sendTheNudge();

    expect(transport.bodies()[0]).toContain(HEALTH_CLOSE_BOOKING);

    const [offer] = await offerRows();
    expect(offer).toMatchObject({
      topic: 'well_baby_18_months',
      subjectChildId: childId,
      fulfilledAt: null,
    });
    // Minted against the outbound row that CARRIED it — an offer nobody received is not
    // an offer (the MEM-10 send-time discipline).
    const [carrier] = await database
      .select({ id: schema.channelMessages.id, templateKey: schema.channelMessages.templateKey })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, offer?.createdFrom as string));
    expect(carrier?.templateKey).toBe('proactive_nudge:health_checkpoint');
    // One week — the nudge's own relevance window, not a number invented here.
    expect(offer?.dueAt.getTime()).toBe(NUDGE_AT.getTime() + CHECKUP_OFFER_TTL_HOURS * 3_600_000);
  });

  it('replays the transcript: the acceptance binds, and no jargon reaches the parent', async () => {
    await sendTheNudge();
    const flaggedActionId = await seedTheOtherQuestions();

    const standing = await openQuestions(REPLY_AT);
    const offerQuestion = standing.find((q) => q.kind === 'checkup_offer');
    expect(standing.map((q) => q.kind).sort()).toEqual([
      'approval',
      'checkup_offer',
      'intro_optin',
    ]);
    expect(offerQuestion).toBeDefined();

    const transport = new FakeTransport();
    const coach = fakeCoach("The 18-month visit is on your week now - want me to do anything else?");

    // TURN 1 — "Add to my week". No closed vocabulary contains it: not a DONE word, not a
    // booking verb, not an affirmative. It is the offer's acceptance and nothing else.
    await routeChannelMessage(
      routerDeps(
        transport,
        recordedResolver({
          target: offerQuestion?.id as string,
          polarity: 'yes',
          confidence: 'high',
        }),
        coach,
        REPLY_AT,
      ),
      {
        family_id: familyId,
        parent_user_id: parentUserId,
        channel_message_id: await inboundText('Add to my week', REPLY_AT, 1),
        provider_message_id: 'SM-in-1',
        received_at: REPLY_AT.toISOString(),
      },
    );

    // The draft the offer promised, held for approval. Hale never books (rule #4).
    const booked = await drafts('book_checkup');
    expect(booked).toHaveLength(1);
    expect(booked[0]?.state).toBe('drafted_for_approval');
    expect(transport.bodies()).toEqual([checkupDraftedReply()]);

    // And the offer is closed by the message that told them so — a second yes cannot
    // draft the same visit twice.
    const [closed] = await offerRows();
    expect(closed?.fulfilledAt).not.toBeNull();
    expect(
      (await openQuestions(REPLY_AT)).some((question) => question.kind === 'checkup_offer'),
    ).toBe(false);

    // TURN 2 — "You said 18 month baby visit". This is the raw reading production's Haiku
    // returned: it bound the words to the FLAGGED calendar draft. That draft can be
    // declined and cannot be approved, so the acceptance no longer binds to it and the
    // turn goes to the coach — where, before, the parent got a sentence about Hale's
    // internal review.
    await routeChannelMessage(
      routerDeps(
        transport,
        recordedResolver({ target: flaggedActionId, polarity: 'yes', confidence: 'high' }),
        coach,
        REPLY_AT,
      ),
      {
        family_id: familyId,
        parent_user_id: parentUserId,
        channel_message_id: await inboundText('You said 18 month baby visit', REPLY_AT, 2),
        provider_message_id: 'SM-in-2',
        received_at: REPLY_AT.toISOString(),
      },
    );

    // TURN 3 — "Yes, please add it", which now names nothing Hale is holding.
    await routeChannelMessage(
      routerDeps(
        transport,
        recordedResolver({ target: 'ambiguous', polarity: 'yes', confidence: 'high' }),
        coach,
        REPLY_AT,
      ),
      {
        family_id: familyId,
        parent_user_id: parentUserId,
        channel_message_id: await inboundText('Yes, please add it', REPLY_AT, 3),
        provider_message_id: 'SM-in-3',
        received_at: REPLY_AT.toISOString(),
      },
    );

    const everythingSaid = transport.bodies().join('\n');
    // NO REVIEWER JARGON, anywhere in the thread.
    expect(everythingSaid).not.toMatch(/cleared my own checks|reviewer|verdict|flagged/i);
    expect(everythingSaid).not.toContain(conflictReply('not_reviewer_approved'));
    // NO MACHINE MENU, and in particular no option list built from action-type labels.
    expect(everythingSaid).not.toMatch(/Which one -/);
    expect(everythingSaid).not.toMatch(/add to your calendar/i);
    // The coach owned both follow-ups, and knew what Hale was holding on each.
    expect(coach.standingQuestions).toHaveLength(2);
    for (const held of coach.standingQuestions) {
      expect(held).toContain('introductions to other Hale families nearby');
    }
  });

  it('MUTATION - with the send-time registration removed, the acceptance finds nothing', async () => {
    // The whole file in one assertion. `recordCheckupOffer` is the only thing standing
    // between "Hale asked a question" and "Hale can hear the answer": take it out and the
    // sweep still sends a perfect message, the parent still accepts it, and nothing at all
    // happens — which is exactly what production did.
    await sendTheNudge({ recordCheckupOffer: async () => ({ status: 'not_an_offer' }) });
    await seedTheOtherQuestions();

    expect(await offerRows()).toHaveLength(0);
    const standing = await openQuestions(REPLY_AT);
    expect(standing.some((question) => question.kind === 'checkup_offer')).toBe(false);

    const transport = new FakeTransport();
    await routeChannelMessage(
      routerDeps(
        transport,
        // Nothing to bind to: the resolver is handed a list the offer is not on.
        recordedResolver({ target: 'ambiguous', polarity: 'yes', confidence: 'high' }),
        fakeCoach('coach takes it'),
        REPLY_AT,
      ),
      {
        family_id: familyId,
        parent_user_id: parentUserId,
        channel_message_id: await inboundText('Add to my week', REPLY_AT, 1),
        provider_message_id: 'SM-in-1',
        received_at: REPLY_AT.toISOString(),
      },
    );

    expect(await drafts('book_checkup')).toHaveLength(0);
  });

  it('an offer past its week is not a question, and cannot be accepted', async () => {
    await sendTheNudge();
    await seedTheOtherQuestions();

    const lapsed = new Date(NUDGE_AT.getTime() + (CHECKUP_OFFER_TTL_HOURS + 1) * 3_600_000);
    const standing = await openQuestions(lapsed);

    // Still an open ledger row — the ledger keeps what Hale offered — and no longer a
    // question, so it can never be listed, named in a choice sentence, or resolved.
    expect((await offerRows())[0]?.fulfilledAt).toBeNull();
    expect(standing.some((question) => question.kind === 'checkup_offer')).toBe(false);

    const transport = new FakeTransport();
    await routeChannelMessage(
      routerDeps(
        transport,
        recordedResolver({ target: 'none', polarity: 'yes', confidence: 'high' }),
        fakeCoach('coach takes it'),
        lapsed,
      ),
      {
        family_id: familyId,
        parent_user_id: parentUserId,
        channel_message_id: await inboundText('yes', lapsed, 1),
        provider_message_id: 'SM-in-1',
        received_at: lapsed.toISOString(),
      },
    );

    expect(await drafts('book_checkup')).toHaveLength(0);
  });
});
