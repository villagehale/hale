import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WEEKDAY_CARE_ASK_TEMPLATE_KEY, WEEKDAY_CARE_FACT_KEY } from '~/lib/care/weekday';
import { FakeReplyTransport } from '~/lib/channel/router/reply-route';
import { type ChannelRouterDeps, routeChannelMessage } from '~/lib/channel/router/route';
import { channelRouterDeps, defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { weekdayCareDedupeKey } from './key';
import { WEEKDAY_CARE_QUESTION_TTL_MS, weekdayCareQuestion } from './question';

/**
 * The open question has no row and no column — it is derived from the message ledger —
 * so a test that injected its source would be testing a stipulation. Against real
 * Postgres, and the last case runs through `defaultOpenQuestionReader()`, which is what
 * the router actually calls: this file is the only pin on that wiring.
 */

const TZ = 'America/Toronto';
/** 10:04 Toronto on Monday 2026-09-14, the instant the ask went out. */
const ASKED_AT = new Date('2026-09-14T14:04:00.000Z');
const SAME_DAY = new Date('2026-09-14T18:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

interface Seeded {
  familyId: string;
  parentUserId: string;
  childId: string;
}

async function seedFamily(externalId = 'sms:weekday'): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: externalId, name: 'Ana', timezone: TZ })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [child] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2024-03-02' })
    .returning({ id: schema.children.id });
  return { familyId, parentUserId, childId: child?.id as string };
}

async function seedAsk(
  seeded: Seeded,
  overrides: { createdAt?: Date; status?: 'queued' | 'failed'; dedupeKey?: string } = {},
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'nudge',
    templateKey: WEEKDAY_CARE_ASK_TEMPLATE_KEY,
    dedupeKey:
      overrides.dedupeKey ??
      weekdayCareDedupeKey(seeded.familyId, seeded.childId, seeded.parentUserId),
    status: overrides.status ?? 'queued',
    createdAt: overrides.createdAt ?? ASKED_AT,
  });
}

describe('weekdayCareQuestion', () => {
  it('is open while the ask is the newest thing Hale said to that parent', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    const open = await weekdayCareQuestion(db.database, { ...seeded, now: SAME_DAY });

    expect(open).toMatchObject({ askedAt: ASKED_AT, childId: seeded.childId });
  });

  it('closes the moment anything else goes out', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reminder',
      templateKey: 'reminder:day_before',
      status: 'queued',
      createdAt: new Date(ASKED_AT.getTime() + 3_600_000),
    });

    expect(await weekdayCareQuestion(db.database, { ...seeded, now: SAME_DAY })).toBeNull();
  });

  it('closes past the 48h window, and stands inside it', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    const justInside = new Date(ASKED_AT.getTime() + WEEKDAY_CARE_QUESTION_TTL_MS - 60_000);
    const justOutside = new Date(ASKED_AT.getTime() + WEEKDAY_CARE_QUESTION_TTL_MS + 60_000);

    // An arrangement does not go stale by breakfast, so lunchtime the next day still
    // answers it — the positive control for the refusal beside it.
    expect(await weekdayCareQuestion(db.database, { ...seeded, now: justInside })).not.toBeNull();
    expect(await weekdayCareQuestion(db.database, { ...seeded, now: justOutside })).toBeNull();
  });

  it('is closed for a send that never reached the phone', async () => {
    const seeded = await seedFamily();
    // `failed` CONSUMED the dedupe key, so the family is never asked twice - but a
    // question nobody was asked is not open.
    await seedAsk(seeded, { status: 'failed' });

    expect(await weekdayCareQuestion(db.database, { ...seeded, now: SAME_DAY })).toBeNull();
  });

  it('is closed when the ask row carries no child to file against', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded, { dedupeKey: 'nudge:fam:weather_swap:2026-09-14:user' });

    expect(await weekdayCareQuestion(db.database, { ...seeded, now: SAME_DAY })).toBeNull();
  });

  it("does not answer the co-parent's phone", async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:coparent', name: 'Sam', timezone: TZ })
      .returning({ id: schema.users.id });
    const coParentUserId = coParent?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: seeded.familyId, userId: coParentUserId, role: 'co_parent' });

    expect(
      await weekdayCareQuestion(db.database, {
        familyId: seeded.familyId,
        parentUserId: coParentUserId,
        now: SAME_DAY,
      }),
    ).toBeNull();
  });

  it('reaches the router through the reader the router actually builds', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    const questions = await defaultOpenQuestionReader().open(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: SAME_DAY,
    });

    const listed = questions.find((question) => question.kind === 'weekday_care');
    expect(listed).toBeDefined();
    // Neither polarity: the ask is an either/or, so a bare "yes" can never resolve it -
    // it can only make every OTHER question ambiguous, which is why it is listed.
    expect(listed?.answerable).toEqual({ yes: false, no: false });
    // Rule #1: nothing about the child in the line that goes to a model.
    expect(listed?.description).not.toContain('Mia');
    expect(listed?.subject).not.toContain('Mia');
  });
});

/**
 * The ROUTER'S OWN composition of this reader and the same-door rule.
 *
 * Every test above injects one half or the other. This is the only thing that runs the
 * two the way `channelRouterDeps` wires them — and the same-door half has no other
 * pin, so without this a router that dropped it would answer an SMS question with a
 * forwarded email and every suite would stay green.
 */
describe('weekdayCareAnswerTarget, as the router builds it', () => {
  async function inbound(seeded: Seeded, channel: 'sms' | 'email'): Promise<string> {
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel,
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: "she's home with me",
        createdAt: SAME_DAY,
      })
      .returning({ id: schema.channelMessages.id });
    return row?.id as string;
  }

  it('opens for a reply through the door the ask went out of', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const inboundChannelMessageId = await inbound(seeded, 'sms');

    const target = await channelRouterDeps(db.database).weekdayCareAnswerTarget(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      inboundChannelMessageId,
      now: SAME_DAY,
    });

    expect(target).toEqual({ status: 'open', childId: seeded.childId });
  });

  it('refuses an email answer to a question Hale put on a phone', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const inboundChannelMessageId = await inbound(seeded, 'email');

    const target = await channelRouterDeps(db.database).weekdayCareAnswerTarget(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      inboundChannelMessageId,
      now: SAME_DAY,
    });

    expect(target).toEqual({ status: 'wrong_channel' });
  });

  it('refuses an answer about a child who has been removed from the account', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    const inboundChannelMessageId = await inbound(seeded, 'sms');
    // The ask's dedupe key still names her, and the ledger row it lives on has no
    // foreign key to the roster: deleting the child leaves the question standing.
    await db.database.delete(schema.children).where(eq(schema.children.id, seeded.childId));

    const target = await channelRouterDeps(db.database).weekdayCareAnswerTarget(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      inboundChannelMessageId,
      now: SAME_DAY,
    });

    expect(target).toEqual({ status: 'child_gone' });
  });
});

/**
 * GATE 2c-bis, END TO END, over the production wiring.
 *
 * The reader above returns the refusal; this is what the ROUTER does with it, over the
 * real `recordWeekdayCare` and the real `family_memory_facts` foreign key. That pairing
 * is the whole point: the fact is filed against the child the ask named, so the only
 * thing standing between a removed child and a constraint violation on the way out of
 * the gate is that the reader refuses first. A fake writer could never fail on it.
 *
 * Everything channel-specific is real. The MODEL is not: the coach and the off-domain
 * screen are stubbed because what is under test is which rows exist afterwards, and the
 * resolver is stubbed because a standing question makes the router reach for it on
 * every one of these turns (rule #8 — no composition quality is asserted here).
 */
describe('a weekday-care answer, through the router', () => {
  const PHONE = '+15551230000';

  async function seedReachable(): Promise<Seeded> {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    const seeded = await seedFamily();
    await db.database.insert(schema.parentChannels).values({
      familyId: seeded.familyId,
      userId: seeded.parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: ASKED_AT,
    });
    await seedAsk(seeded);
    return seeded;
  }

  /** One text from the parent, routed. The production deps, minus the model. */
  async function text(seeded: Seeded, body: string) {
    const warnings: string[] = [];
    const coach = { calls: 0 };
    const providerMessageId = `SM-${SAME_DAY.getTime()}`;
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId,
        status: 'delivered',
        body,
        createdAt: SAME_DAY,
        sentAt: SAME_DAY,
      })
      .returning({ id: schema.channelMessages.id });
    const deps: ChannelRouterDeps = {
      ...channelRouterDeps(db.database),
      transport: new FakeReplyTransport(),
      offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
      replyResolver: { read: async () => ({ status: 'unresolved', reason: 'no_target' }) },
      coach: {
        async respond() {
          coach.calls += 1;
          return { reply: 'Noted.', planOffer: null, activityPromise: null, spotWatch: null };
        },
      },
      limiter: new FakeRateLimiter(() => SAME_DAY.getTime()),
      now: () => SAME_DAY,
      log: {
        info: () => {},
        warn: (payload: unknown) => warnings.push(JSON.stringify(payload)),
        error: () => {},
      },
    };
    const result = await routeChannelMessage(deps, {
      family_id: seeded.familyId,
      parent_user_id: seeded.parentUserId,
      channel_message_id: row?.id as string,
      provider_message_id: providerMessageId,
      received_at: SAME_DAY.toISOString(),
    });
    return { result, warnings, coachCalls: coach.calls };
  }

  async function careFacts(familyId: string) {
    return db.database
      .select({ childId: schema.familyMemoryFacts.childId })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          eq(schema.familyMemoryFacts.factKey, WEEKDAY_CARE_FACT_KEY),
        ),
      );
  }

  it('refuses by name when the child was removed, and still lets the coach answer', async () => {
    const seeded = await seedReachable();
    await db.database.delete(schema.children).where(eq(schema.children.id, seeded.childId));

    const { result, warnings, coachCalls } = await text(seeded, 'she is home with me');

    // No crash, no half-turn: the refusal is named in the log, nothing is filed, and
    // the parent still gets an answer.
    expect(warnings.join('|')).toContain('child_gone');
    expect(await careFacts(seeded.familyId)).toEqual([]);
    expect(coachCalls).toBe(1);
    expect(result.status).toBe('agent_replied');
  });

  it('records the fact when the child is still there', async () => {
    const seeded = await seedReachable();

    const { result, coachCalls } = await text(seeded, 'she is home with me');

    // The positive control, through the SAME writer and the same foreign key: without
    // it the refusal above would pass on a router that had simply stopped filing.
    expect(await careFacts(seeded.familyId)).toEqual([{ childId: seeded.childId }]);
    expect(coachCalls).toBe(1);
    expect(result.status).toBe('agent_replied');
  });
});
