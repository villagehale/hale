import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { createReplyTransport } from '~/lib/channel/router/reply-transport';
import {
  FakeIdentityAsk,
  FakeExtractor,
  FakeIntentReader,
  fakeAckComposer,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { WATCH_OFFER } from '~/lib/channel/intake/copy';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import {
  FOUNDER_NOTE_DECLINED_ACK,
  FOUNDER_NOTE_SENT_ACK,
  FOUNDER_NOTE_TEMPLATE_KEY,
  FOUNDER_PING_TEMPLATE_KEY,
  founderNote,
  founderPing,
} from '~/lib/channel/founder/copy';
import {
  FOUNDER_WELCOME_TTL_HOURS,
  defaultFounderPingPorts,
  offerFounderWelcome,
} from '~/lib/channel/founder/ping';
import { defaultFounderReplyDeps } from '~/lib/channel/founder/reply';
import { founderWelcomeHandler } from '~/lib/channel/router/handlers';
import { channelRouterDeps, defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { type ChannelRouterDeps, routeChannelMessage } from '~/lib/channel/router/route';
import type { ChannelCoachRuntime } from '~/lib/channel/router/coach-runtime';
import { type ReplyResolver, toReading } from '~/lib/channel/router/resolve';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { encryptString } from '~/lib/crypto/string-cipher';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * THE FOUNDER'S WELCOME NOTE — a poster arrival, a ping, one word, and a note in a
 * stranger's thread that a person actually wrote.
 *
 * WHAT THIS PINS, end to end, over real Postgres: the REAL intake state machine
 * provisions a family that walked in from the Georgetown EarlyON poster; the ping
 * registers itself on the MEM-10 open-loops ledger in the SAME flow as the send (the
 * offer-is-a-proposal doctrine); the founder's YES is read by the REAL open-question
 * reader and the REAL handler chain and resolves to that row; and the note lands in the
 * NEW family's thread with its own template key, its own audit row, and the offer closed
 * against the message that made good on it.
 *
 * The three seams that are Fakes are the three that leave the building: the SMS wire, the
 * intake extractor (rule #8 — its quality is an eval's job, not a mock's), and the model's
 * words. Everything that decides anything is the deployed code.
 *
 * The MUTATION at the bottom is the point of the whole file: take away the send-time
 * registration and the founder still gets a perfect ping, still says yes, and nothing at
 * all happens to the family.
 */

const TZ = 'America/Toronto';
const APP_KEY = Buffer.alloc(32, 9).toString('base64');
const FOUNDER_EMAIL = 'founder@villagehale.com';
const FOUNDER_PHONE = '+14165550111';
const PARENT_PHONE = '+14165550122';
const OTHER_PARENT_PHONE = '+14165550133';

/** The poster body the QR card prefills — the whole trigger, and the only place the
 * source code enters the system. */
const GEORGETOWN = 'HALE earlyon-georgetown';
/** A library QR: a real venue, a real source code, and NOT one of the founder's posters. */
const LIBRARY = 'HALE LIBRARY';

const INTAKE_AT = new Date('2026-08-21T14:00:00.000Z');
/** Twenty minutes later — he is holding his phone. */
const REPLY_AT = new Date('2026-08-21T14:20:00.000Z');

describe("the founder's welcome note", () => {
  let db: TestDb;
  let database: Database;
  let founderUserId: string;
  let founderFamilyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    vi.stubEnv('FOUNDER_ALERT_EMAIL', FOUNDER_EMAIL);
    vi.stubEnv('WELCOME_BCC', '');

    // The founder is a Hale user like any other: an account, a household, and a verified
    // SMS channel. His NUMBER is nowhere in the source — the lane resolves it from this
    // row, by the address the ops signals already identify him with.
    const [user] = await database
      .insert(schema.users)
      .values({ email: FOUNDER_EMAIL, name: 'Barton', timezone: TZ })
      .returning({ id: schema.users.id });
    founderUserId = (user as { id: string }).id;

    const [family] = await database
      .insert(schema.families)
      .values({ displayName: 'Dong family', onboardingStage: 'sms_active', areaCoarse: 'L7G' })
      .returning({ id: schema.families.id });
    founderFamilyId = (family as { id: string }).id;

    await database
      .insert(schema.familyMembers)
      .values({ familyId: founderFamilyId, userId: founderUserId, role: 'primary_parent' });
    await database.insert(schema.parentChannels).values({
      userId: founderUserId,
      familyId: founderFamilyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(FOUNDER_PHONE),
      phoneE164Hash: phoneBlindIndex(FOUNDER_PHONE),
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  // ── surface 1 · a stranger texts the poster code ───────────────────────────

  function intakeDeps(transport: FakeTransport): IntakeDeps {
    return {
      transport,
      // The REAL threader over the same store: what intake says after provisioning is
      // what the coach picks the conversation up from.
      threadMessage: threadProactiveMessage,
      // SEAM: the model that reads a parent's sentence. Faked for MECHANICS only — what
      // it can actually pull out of real words is an eval's job (rule #8).
      extractor: new FakeExtractor([
        { children: [{ name: 'Ada', ageMonths: 30, agePrecision: 'months' }], postalCode: null },
      ]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'a clear yes' },
      ]),
      radar: fakeRadar,
      ackComposer: fakeAckComposer,
      answerComposer: fakeSilentAnswerComposer,
      identityAsk: new FakeIdentityAsk(),
      seedCivic: async () => 0,
      resolveCenter: async () => null,
      discoveryTrigger: () => {},
      limiter: new FakeRateLimiter(() => INTAKE_AT.getTime()),
      now: INTAKE_AT,
    };
  }

  /** Unique across every inbound in a test: `channel_messages` has a partial unique index
   * on an inbound's provider id, so two arrivals sharing one would collide. */
  let inboundSeq = 0;

  /**
   * The real intake, driven to `provisioned`.
   *
   * TWO MESSAGES, because that is what the machine does: the first text is the poster tag
   * (which is where the source code enters the system and where the greeting goes back),
   * and the second carries the child. No postal code is asked for or given — the venue's
   * own coarse area places the family, which is the whole point of a QR poster.
   */
  async function arriveFrom(
    tag: string,
    phone: string,
  ): Promise<{ familyId: string; transport: FakeTransport }> {
    const transport = new FakeTransport();
    const deps = intakeDeps(transport);
    const text = (body: string) => {
      inboundSeq += 1;
      return handleInboundSms(
        database,
        transport.inbound(phone, body, { providerId: `SM-in-${inboundSeq}` }),
        deps,
      );
    };

    await text(tag);
    const outcome = await text('Ada is 30 months');
    if (outcome.status !== 'provisioned') {
      throw new Error(`fixture drift: intake ended at ${outcome.status}`);
    }
    return { familyId: outcome.familyId, transport };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** The parent intake provisioned for a family — whose thread the note belongs in. */
  async function primaryParentOf(familyId: string): Promise<string> {
    const [row] = await database
      .select({ userId: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    if (!row) throw new Error(`fixture drift: family ${familyId} has no member`);
    return row.userId;
  }

  async function messages(familyId: string, templateKey: string) {
    return database
      .select({
        id: schema.channelMessages.id,
        dedupeKey: schema.channelMessages.dedupeKey,
        category: schema.channelMessages.category,
        parentUserId: schema.channelMessages.parentUserId,
      })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, familyId),
          eq(schema.channelMessages.templateKey, templateKey),
        ),
      );
  }

  async function offers() {
    return database
      .select({
        id: schema.agentCommitments.id,
        topic: schema.agentCommitments.topic,
        subjectFamilyId: schema.agentCommitments.subjectFamilyId,
        summary: schema.agentCommitments.summary,
        createdFrom: schema.agentCommitments.createdFrom,
        dueAt: schema.agentCommitments.dueAt,
        fulfilledAt: schema.agentCommitments.fulfilledAt,
        fulfilledBy: schema.agentCommitments.fulfilledBy,
        cancelledReason: schema.agentCommitments.cancelledReason,
      })
      .from(schema.agentCommitments)
      .where(eq(schema.agentCommitments.commitmentKind, 'founder_welcome_offer'));
  }

  /**
   * The parent's own coach transcript — the ONE place a reply can find what it is
   * replying to, because `channel_messages` deliberately stores `body: null` (rule #1).
   * Read through the real note anchor the C1 router resolves on, so a row only shows up
   * here if it landed in the thread the coach will actually re-read.
   */
  async function threadTurns(familyId: string, parentUserId: string) {
    return database
      .select({ role: schema.messages.role, content: schema.messages.content })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
      .where(
        and(
          eq(schema.conversations.familyId, familyId),
          eq(schema.conversations.noteKey, channelSmsNoteKey(parentUserId)),
        ),
      )
      .orderBy(schema.messages.createdAt);
  }

  async function auditVerbs(familyId: string): Promise<string[]> {
    const rows = await database
      .select({ verb: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    return rows.map((row) => row.verb);
  }

  async function openQuestions(now: Date) {
    return defaultOpenQuestionReader().open(database, {
      familyId: founderFamilyId,
      parentUserId: founderUserId,
      now,
    });
  }

  // ── surface 2 · the founder answers ────────────────────────────────────────

  /** The resolver, post-processing a RECORDED model answer through the real `toReading` —
   * where the id is checked against the offered set and the grade is applied. The model's
   * own pick is the eval's job (rule #8). */
  function recordedResolver(raw: {
    target: string;
    polarity: string;
    confidence: string;
  }): ReplyResolver {
    return { read: async ({ questions }) => toReading(raw, questions) };
  }

  /** The coach, for the turns that fall through to it. It says one obviously-synthetic
   * thing: what this file is about is which turns REACH it, never what it writes. */
  const silentCoach = {
    async respond() {
      return { reply: 'coach takes it', planOffer: null, activityPromise: null };
    },
  } as unknown as ChannelCoachRuntime;

  function routerDeps(
    transport: FakeTransport,
    resolver: ReplyResolver,
    now: Date,
  ): ChannelRouterDeps {
    const base = channelRouterDeps(database);
    return {
      ...base,
      // The chain, with the founder lane's own wire swapped for the fake. Everything that
      // DECIDES — the offer read, the TTL, the live-channel gate, the ledger closure — is
      // the deployed code.
      handlers: base.handlers.map((handler) =>
        handler.name === 'founder_welcome'
          ? founderWelcomeHandler({ ...defaultFounderReplyDeps(), transport })
          : handler,
      ),
      // The production adapter over the fake pipe: the router hands it a resolved sms
      // route, the fake records the send — the same recorder the founder lane writes to.
      transport: createReplyTransport({ phone: transport, email: null }),
      replyResolver: resolver,
      coach: silentCoach,
      offDomain: { consider: async () => ({ status: 'in_domain' as const, fallback: null }) },
      limiter: new FakeRateLimiter(),
      now: () => now,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  }

  async function founderTexts(
    body: string,
    resolver: ReplyResolver,
    at: Date,
    n: number,
  ): Promise<FakeTransport> {
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: founderFamilyId,
        parentUserId: founderUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId: `SM-founder-${n}`,
        status: 'delivered',
        body,
        sentAt: at,
      })
      .returning({ id: schema.channelMessages.id });

    const transport = new FakeTransport();
    await routeChannelMessage(routerDeps(transport, resolver, at), {
      family_id: founderFamilyId,
      parent_user_id: founderUserId,
      channel_message_id: (row as { id: string }).id,
      provider_message_id: `SM-founder-${n}`,
      received_at: at.toISOString(),
    });
    return transport;
  }

  /** The offer as the resolver sees it, so a test says YES to the thing Hale is actually
   * holding rather than to an id it made up. */
  async function offerQuestionId(now: Date): Promise<string> {
    const standing = await openQuestions(now);
    const question = standing.find((q) => q.kind === 'founder_welcome_offer');
    if (!question) throw new Error('no founder welcome offer is standing');
    return question.id;
  }

  // ── the journey ────────────────────────────────────────────────────────────

  it('a poster arrival pings the founder and writes the offer down against the ping', async () => {
    const { familyId, transport } = await arriveFrom(GEORGETOWN, PARENT_PHONE);

    // The ping went to HIS number, and it names the poster and nothing else (rule #1).
    const ping = transport.sent.at(-1);
    expect(ping).toEqual({ to: FOUNDER_PHONE, body: founderPing('Georgetown') });
    expect(ping?.body).not.toContain('Ada');
    expect(ping?.body).not.toContain(PARENT_PHONE);

    const [pingRow] = await messages(founderFamilyId, FOUNDER_PING_TEMPLATE_KEY);
    expect(pingRow).toMatchObject({
      category: 'founder',
      parentUserId: founderUserId,
      dedupeKey: `founder-welcome-ping:${familyId}`,
    });
    expect(await auditVerbs(founderFamilyId)).toContain('founder_welcome_offered');

    // The offer is a ROW, minted against the message that CARRIED it, and it knows which
    // household it is about.
    const [offer] = await offers();
    expect(offer).toMatchObject({
      topic: 'earlyon-georgetown',
      subjectFamilyId: familyId,
      createdFrom: pingRow?.id,
      fulfilledAt: null,
    });
    expect(offer?.dueAt.getTime()).toBe(
      INTAKE_AT.getTime() + FOUNDER_WELCOME_TTL_HOURS * 3_600_000,
    );
    // And it is a QUESTION the reply resolver can see.
    const standing = await openQuestions(REPLY_AT);
    expect(standing.map((q) => q.kind)).toEqual(['founder_welcome_offer']);
  });

  it('YES puts the note in the new family\'s thread and closes the offer against it', async () => {
    const { familyId } = await arriveFrom(GEORGETOWN, PARENT_PHONE);

    const transport = await founderTexts(
      'yes',
      recordedResolver({
        target: await offerQuestionId(REPLY_AT),
        polarity: 'yes',
        confidence: 'high',
      }),
      REPLY_AT,
      1,
    );

    // Two sends: the note to the family, and the ack to the founder.
    expect(transport.sent).toEqual([
      { to: PARENT_PHONE, body: founderNote('Georgetown') },
      { to: FOUNDER_PHONE, body: FOUNDER_NOTE_SENT_ACK },
    ]);

    const [note] = await messages(familyId, FOUNDER_NOTE_TEMPLATE_KEY);
    expect(note).toMatchObject({
      category: 'founder',
      dedupeKey: `founder-welcome-note:${familyId}`,
    });
    // The receiving family's own trail carries the send — rule #6, on the household the
    // message actually reached.
    expect(await auditVerbs(familyId)).toContain('founder_welcome_sent');

    // Closed by the NOTE, not by the ack: a kept promise points at the message that kept
    // it, and that message is in the other family's thread.
    const [closed] = await offers();
    expect(closed?.fulfilledAt).not.toBeNull();
    expect(closed?.fulfilledBy).toBe(note?.id);
    expect((await openQuestions(REPLY_AT)).map((q) => q.kind)).toEqual([]);
  });

  it("the ping lands in the founder's own thread, so his YES has an antecedent", async () => {
    await arriveFrom(GEORGETOWN, PARENT_PHONE);

    // His YES is read against `messages` and only against `messages`. An unthreaded
    // ping is a question Hale asked and cannot see itself having asked — the coach
    // reads a bare "yes" with nothing above it.
    const turns = await threadTurns(founderFamilyId, founderUserId);
    expect(turns).toEqual([{ role: 'assistant', content: founderPing('Georgetown') }]);
  });

  it("the note lands in the NEW family's thread, on their side of the wall", async () => {
    const { familyId } = await arriveFrom(GEORGETOWN, PARENT_PHONE);
    const parentUserId = await primaryParentOf(familyId);

    await founderTexts(
      'yes',
      recordedResolver({
        target: await offerQuestionId(REPLY_AT),
        polarity: 'yes',
        confidence: 'high',
      }),
      REPLY_AT,
      1,
    );

    // Hale's first personal words to this household, where their reply to it will be
    // read. On THEIR thread: one household's transcript never carries another's — and
    // it sits under what intake said to them, so the coach picks up a whole
    // conversation rather than a note with nothing above it.
    const familyTurns = await threadTurns(familyId, parentUserId);
    expect(familyTurns.at(-1)).toEqual({
      role: 'assistant',
      content: founderNote('Georgetown'),
    });
    expect(familyTurns.at(0)?.content).toContain(WATCH_OFFER);
    // And the founder's thread has his ping and his ack, and no trace of the note's
    // recipient (rule #1).
    const founderTurns = await threadTurns(founderFamilyId, founderUserId);
    expect(founderTurns.map((t) => t.content)).toEqual([
      founderPing('Georgetown'),
      'yes',
      FOUNDER_NOTE_SENT_ACK,
    ]);
    expect(founderTurns.map((t) => t.content).join(' ')).not.toContain(PARENT_PHONE);
  });

  it('a family that did not come from a poster is never mentioned to anyone', async () => {
    const { familyId, transport } = await arriveFrom(LIBRARY, PARENT_PHONE);

    expect(transport.sent.every((sent) => sent.to === PARENT_PHONE)).toBe(true);
    expect(await messages(founderFamilyId, FOUNDER_PING_TEMPLATE_KEY)).toEqual([]);
    expect(await offers()).toEqual([]);
    expect(await auditVerbs(founderFamilyId)).not.toContain('founder_welcome_offered');
    // POSITIVE CONTROL for the three absences above: the same drive with the poster code
    // does produce all of them, so this test cannot pass by the lane being switched off.
    const georgetown = await arriveFrom(GEORGETOWN, OTHER_PARENT_PHONE);
    expect(georgetown.familyId).not.toBe(familyId);
    expect(await messages(founderFamilyId, FOUNDER_PING_TEMPLATE_KEY)).toHaveLength(1);
  });

  it('a second completion for the same family does not ping twice', async () => {
    const { familyId, transport } = await arriveFrom(GEORGETOWN, PARENT_PHONE);
    expect(await messages(founderFamilyId, FOUNDER_PING_TEMPLATE_KEY)).toHaveLength(1);

    // The same arrival, replayed — a re-drained job, a retried webhook, a re-run turn.
    const again = await offerFounderWelcome(
      database,
      { newFamilyId: familyId, sourceCode: 'earlyon-georgetown', now: INTAKE_AT },
      defaultFounderPingPorts(transport),
    );

    expect(again).toEqual({ status: 'already_pinged' });
    expect(await messages(founderFamilyId, FOUNDER_PING_TEMPLATE_KEY)).toHaveLength(1);
    expect(await offers()).toHaveLength(1);
  });

  it('NO closes the offer with a reason and nobody is texted', async () => {
    const { familyId } = await arriveFrom(GEORGETOWN, PARENT_PHONE);

    const transport = await founderTexts(
      'no thanks',
      recordedResolver({
        target: await offerQuestionId(REPLY_AT),
        polarity: 'no',
        confidence: 'high',
      }),
      REPLY_AT,
      1,
    );

    expect(transport.sent).toEqual([{ to: FOUNDER_PHONE, body: FOUNDER_NOTE_DECLINED_ACK }]);
    expect(await messages(familyId, FOUNDER_NOTE_TEMPLATE_KEY)).toEqual([]);
    const [closed] = await offers();
    expect(closed?.fulfilledAt).toBeNull();
    expect(closed?.cancelledReason).toBe('founder_welcome_declined');
  });

  it('an offer past its two days is not a question, and a YES sends nothing', async () => {
    const { familyId } = await arriveFrom(GEORGETOWN, PARENT_PHONE);
    const lapsed = new Date(INTAKE_AT.getTime() + (FOUNDER_WELCOME_TTL_HOURS + 1) * 3_600_000);

    expect((await openQuestions(lapsed)).map((q) => q.kind)).toEqual([]);

    const transport = await founderTexts(
      'yes',
      recordedResolver({ target: 'ambiguous', polarity: 'yes', confidence: 'high' }),
      lapsed,
      1,
    );

    expect(await messages(familyId, FOUNDER_NOTE_TEMPLATE_KEY)).toEqual([]);
    expect(transport.bodies()).not.toContain(FOUNDER_NOTE_SENT_ACK);
    const [lapsedOffer] = await offers();
    expect(lapsedOffer?.fulfilledAt).toBeNull();
  });

  it('MUTATION - with the send-time registration removed, the YES finds nothing', async () => {
    // The whole file in one assertion. Take out the ONE write that turns a sentence into a
    // standing question — nothing else — and everything still looks perfect: the family is
    // provisioned, the founder gets a flawless ping, he says yes, and the household he was
    // told about hears nothing at all.
    //
    // The arrival is driven with a non-poster tag so the real trigger stays quiet, and the
    // ping is then run through the REAL lane with only `recordCommitment` removed.
    const { familyId } = await arriveFrom(LIBRARY, PARENT_PHONE);
    const pingTransport = new FakeTransport();
    const pinged = await offerFounderWelcome(
      database,
      { newFamilyId: familyId, sourceCode: 'earlyon-georgetown', now: INTAKE_AT },
      {
        ...defaultFounderPingPorts(pingTransport),
        recordCommitment: async () => ({ status: 'not_recorded', reason: 'write_failed' }),
      },
    );

    // The founder was told, in the words he would have been told in either way.
    expect(pinged).toEqual({ status: 'not_pinged', reason: 'not_recorded' });
    expect(pingTransport.sent).toEqual([
      { to: FOUNDER_PHONE, body: founderPing('Georgetown') },
    ]);
    expect(await messages(founderFamilyId, FOUNDER_PING_TEMPLATE_KEY)).toHaveLength(1);

    expect(await offers()).toEqual([]);
    expect((await openQuestions(REPLY_AT)).map((q) => q.kind)).toEqual([]);

    const transport = await founderTexts(
      'yes',
      recordedResolver({ target: 'ambiguous', polarity: 'yes', confidence: 'high' }),
      REPLY_AT,
      1,
    );

    expect(await messages(familyId, FOUNDER_NOTE_TEMPLATE_KEY)).toEqual([]);
    expect(transport.bodies()).not.toContain(FOUNDER_NOTE_SENT_ACK);
  });
});
