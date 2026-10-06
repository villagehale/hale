import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFact } from '~/lib/memory/facts';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import {
  DUTY_OPEN_FACT_KEY,
  DUTY_STOP_ASKING_KEY,
  DUTY_STOP_ASKING_MS,
  type DutySendPorts,
  answerParentDutyAsk,
  deliverDutyGroupLine,
  dutyOpenValue,
  dutyStopAskingActive,
  emailDutyInGroup,
  planFamilyDutyAsks,
  sweepDutyAsks,
} from './asks';
import { DUTY_NIGHT_BEFORE_COPY_EN } from './copy';
import { COPARENT_DUTY_COPY_LOCKED_ENV } from './copy';
import { COPARENT_DUTY_SENDS_ENABLED_ENV } from './flag';
import { commitDutyUpdate, loadReadableDuties } from './model';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Sunday 27 Sep 2026, 15:00 in Toronto. */
const SUNDAY_AFTERNOON = new Date('2026-09-27T19:00:00.000Z');
/** Sunday 27 Sep 2026, 18:00 in Toronto. Inside 17:00–21:00. */
const SUNDAY_EVENING = new Date('2026-09-27T22:00:00.000Z');
const MONDAY = new Date('2026-09-28T19:00:00.000Z');
const TUESDAY = new Date('2026-09-29T19:00:00.000Z');

async function secondParent(familyId: string, name: string): Promise<string> {
  const email = `${name}-${familyId}@example.test`;
  const inserted = (await db.database.execute(
    sql`insert into users (email, name) values (${email}, ${name}) returning id`,
  )) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
  const user = (Array.isArray(inserted) ? inserted : (inserted.rows ?? []))[0];
  if (!user) throw new Error('second parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

async function claimGroup(familyId: string, chatId: string | null): Promise<void> {
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: chatId })
    .where(eq(schema.families.id, familyId));
}

async function kidBlock(input: {
  familyId: string;
  userId: string;
  eventId: string;
  title: string;
  start: Date;
  status?: string;
}): Promise<void> {
  const [existing] = await db.database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, input.familyId),
        eq(schema.integrations.userId, input.userId),
        eq(schema.integrations.provider, 'gcal'),
      ),
    )
    .limit(1);
  const integrationId =
    existing?.id ?? (await seedIntegration(db.database, input.familyId, input.userId, 'gcal'));
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId,
    eventId: input.eventId,
    familyId: input.familyId,
    userId: input.userId,
    startAt: input.start,
    endAt: new Date(input.start.getTime() + 60 * 60 * 1000),
    kidRelated: true,
    title: input.title,
    status: input.status ?? 'confirmed',
    updatedStamp: '1',
  });
}

function sendPorts(send: DutySendPorts['send']): DutySendPorts {
  return {
    target: async () => ({ channel: 'group', chatId: 'chat-duty', familyId: 'ignored' }),
    gate: vi.fn(async () => ({ allowed: true as const, optOut: 'short' as const })),
    gatePorts: () => ({
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => true,
      parentTimeZone: async () => 'America/Toronto',
    }),
    send,
    spend: async () => ({
      discretionaryDay: 0,
      discretionaryWeek: 0,
      ceilingToday: 0,
      discretionaryDayAt: [],
      discretionaryWeekAt: [],
      ceilingTodayAt: [],
    }),
  };
}

describe('duty ask sweep', () => {
  it('is a no-op when the flag is off, including a cancelled duty', async () => {
    const family = await seedFamily(db.database, 'Flag off');
    const sam = await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-off');
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-off',
      title: 'Maya swim',
      start: MONDAY,
      status: 'cancelled',
    });
    await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      parentCount: 2,
      subjectKey: 'evt-off',
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text',
      now: SUNDAY_AFTERNOON,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    void sam;
    const send = vi.fn();
    const result = await sweepDutyAsks(db.database, {
      now: SUNDAY_AFTERNOON,
      ports: sendPorts(send),
    });
    expect(result.enabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
    const live = await loadReadableDuties(db.database, family.familyId);
    expect(live.some((row) => row.role === 'pickup')).toBe(true);
  });

  it('asks one question when two events have no kid in the title', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Two kids');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-two');
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, SUNDAY_AFTERNOON);
    await seedChild(db.database, family.familyId, 'Leo', 48, undefined, SUNDAY_AFTERNOON);
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-swim',
      title: 'Swim',
      start: MONDAY,
    });
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-piano',
      title: 'Piano',
      start: TUESDAY,
    });
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: SUNDAY_AFTERNOON,
      bubbleLeaving: true,
    });
    expect('plan' in view).toBe(true);
    if (!('plan' in view)) return;
    const questions = view.plan.foldLines.filter((row) => row.opensQuestion);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.mode).toBe('which_kid');
    expect(view.plan.foldLines.some((row) => row.mode === 'week_overview')).toBe(true);
  });

  it('asks when both parents claim and does not pick a winner', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Both claimed');
    const sam = await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-both');
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, SUNDAY_AFTERNOON);
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-both',
      title: 'Maya swim',
      start: MONDAY,
    });
    const base = {
      mode: 'write' as const,
      familyId: family.familyId,
      parentCount: 2,
      subjectKey: 'evt-both',
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      source: 'text' as const,
      now: SUNDAY_AFTERNOON,
      childId: null,
      question: false,
      askWhichKid: false,
    };
    const first = await commitDutyUpdate(db.database, {
      ...base,
      actorUserId: family.parentUserId,
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
    });
    await commitDutyUpdate(db.database, {
      ...base,
      actorUserId: sam,
      slot: { role: 'pickup', claim: 'self', name: null, userId: sam, confidence: 1 },
      prior: first.state,
    });
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: SUNDAY_AFTERNOON,
      bubbleLeaving: true,
    });
    if (!('plan' in view)) throw new Error('expected a plan');
    expect(view.plan.foldLines.some((row) => row.mode === 'both_claimed')).toBe(true);
    const send = vi.fn();
    await sweepDutyAsks(db.database, { now: SUNDAY_AFTERNOON, ports: sendPorts(send) });
    expect(send).not.toHaveBeenCalled();
    const live = await loadReadableDuties(db.database, family.familyId);
    expect(live.find((row) => row.role === 'pickup')?.status).toBe('conflict');
    expect(live.find((row) => row.role === 'pickup')?.ownerUserId).toBeNull();
  });

  it('closes a duty when the event is cancelled and does not delete the row', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Cancelled');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-cancel');
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-cancel',
      title: 'Maya swim',
      start: MONDAY,
      status: 'cancelled',
    });
    await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      parentCount: 2,
      subjectKey: 'evt-cancel',
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text',
      now: SUNDAY_AFTERNOON,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    const before = await db.database
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, family.familyId));
    await sweepDutyAsks(db.database, { now: SUNDAY_AFTERNOON });
    const after = await db.database
      .select({
        id: schema.familyMemoryFacts.id,
        validUntil: schema.familyMemoryFacts.validUntil,
        familyId: schema.familyMemoryFacts.familyId,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, family.familyId));
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(after.every((row) => row.validUntil !== null)).toBe(true);
    expect(await loadReadableDuties(db.database, family.familyId)).toEqual([]);
    const audits = await db.database
      .select({
        actionTaken: schema.auditLog.actionTaken,
        after: schema.auditLog.after,
        familyId: schema.auditLog.familyId,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    expect(
      audits.some(
        (row) =>
          row.actionTaken === 'logistics_decision_recorded' &&
          row.after &&
          typeof row.after === 'object' &&
          (row.after as { invalidated?: boolean }).invalidated === true,
      ),
    ).toBe(true);
  });

  it('steps down after three unanswered asks and does not text', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Step down');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-step');
    await writeFact(db.database, {
      familyId: family.familyId,
      childId: null,
      factType: 'logistic',
      factKey: DUTY_OPEN_FACT_KEY,
      factValue: dutyOpenValue({
        eventKey: 'evt-step',
        role: 'pickup',
        unanswered: 3,
        silentNamed: true,
        status: 'open',
      }),
      confidence: 1,
      inferredBy: 'test',
      validFrom: SUNDAY_AFTERNOON,
    });
    const send = vi.fn();
    const result = await sweepDutyAsks(db.database, {
      now: SUNDAY_AFTERNOON,
      ports: sendPorts(send),
    });
    expect(result.steppedDown).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const facts = await db.database
      .select({
        factKey: schema.familyMemoryFacts.factKey,
        factValue: schema.familyMemoryFacts.factValue,
        validUntil: schema.familyMemoryFacts.validUntil,
        familyId: schema.familyMemoryFacts.familyId,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, family.familyId));
    const live = facts.find((row) => row.factKey === DUTY_OPEN_FACT_KEY && row.validUntil === null);
    expect(live?.factValue).toMatchObject({ status: 'stepped_down' });
    expect(facts.filter((row) => row.factKey === DUTY_OPEN_FACT_KEY).length).toBeGreaterThan(1);
    const messages = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, family.familyId));
    expect(messages).toEqual([]);
  });

  it('never initiates 1:1 when the family has no Linq group', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const family = await seedFamily(db.database, 'No group');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, null);
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, SUNDAY_EVENING);
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-solo',
      title: 'Maya swim',
      start: MONDAY,
    });
    await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      parentCount: 2,
      subjectKey: 'evt-solo',
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text',
      now: SUNDAY_EVENING,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    const send = vi.fn();
    const ports = sendPorts(send);
    ports.target = async () => ({ channel: 'legacy' });
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: SUNDAY_EVENING,
      bubbleLeaving: false,
      ports,
    });
    if (!('plan' in view)) throw new Error('expected a plan');
    expect(view.plan.sendLines.some((row) => row.mode === 'night_before')).toBe(true);
    const delivered = await deliverDutyGroupLine(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        text: 'Sam has pickup tomorrow',
        now: SUNDAY_EVENING,
        dedupeKey: `duty-solo-${family.familyId}`,
        templateKey: 'linq:group_duty_night_before',
        bubbleKind: 'discretionary',
        sendsActive: true,
      },
      ports,
    );
    expect(delivered).toEqual({ status: 'skipped', reason: 'no_group' });
    expect(send).not.toHaveBeenCalled();
    expect(ports.gate).not.toHaveBeenCalled();
  });

  it('does not hand a placeholder to the transport', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const family = await seedFamily(db.database, 'Placeholder');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-placeholder');
    const send = vi.fn();
    const gate = vi.fn(async () => ({ allowed: true as const, optOut: 'short' as const }));
    const ports = sendPorts(send);
    ports.gate = gate;
    ports.target = async () => ({
      channel: 'group',
      chatId: 'chat-placeholder',
      familyId: family.familyId,
    });
    const delivered = await deliverDutyGroupLine(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        text: DUTY_NIGHT_BEFORE_COPY_EN,
        now: SUNDAY_EVENING,
        dedupeKey: `duty-ph-${family.familyId}`,
        templateKey: 'linq:group_duty_night_before',
        bubbleKind: 'discretionary',
        sendsActive: true,
      },
      ports,
    );
    expect(delivered).toEqual({ status: 'skipped', reason: 'placeholder' });
    expect(send).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(emailDutyInGroup().suppressed).toBe('mail_not_in_group');
  });

  it('sends only to the group chat, and only after the gate allows it', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const family = await seedFamily(db.database, 'Group send');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-send');
    const send = vi.fn(async (input: { chatId: string; text: string }) => ({
      providerMessageId: `linq-${input.chatId}`,
    }));
    const gate = vi.fn(async () => ({ allowed: true as const, optOut: 'short' as const }));
    const ports = sendPorts(send);
    ports.gate = gate;
    ports.target = async () => ({
      channel: 'group',
      chatId: 'chat-send',
      familyId: family.familyId,
    });
    const delivered = await deliverDutyGroupLine(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        text: 'Confirm tomorrow.',
        now: SUNDAY_EVENING,
        dedupeKey: `duty-send-${family.familyId}`,
        templateKey: 'linq:group_duty_night_before',
        bubbleKind: 'discretionary',
        sendsActive: true,
      },
      ports,
    );
    expect(delivered).toEqual({ status: 'sent', chatId: 'chat-send' });
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'duty_ask', familyId: family.familyId }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0]?.[0];
    expect(body?.chatId).toBe('chat-send');
    expect(body?.text).not.toContain('TODO-Design');
    expect(JSON.stringify(body)).not.toMatch(/\+\d{10}/);
  });

  it('sends the locked night-before sentence and nothing with a booking claim', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const family = await seedFamily(db.database, 'Locked night');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-locked');
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, SUNDAY_EVENING);
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-locked',
      title: 'Maya swim',
      start: MONDAY,
    });
    await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      parentCount: 2,
      subjectKey: 'evt-locked',
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text',
      now: SUNDAY_EVENING,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    const send = vi.fn(async (input: { text: string }) => ({
      providerMessageId: `linq-${input.text.length}`,
    }));
    const result = await sweepDutyAsks(db.database, {
      now: SUNDAY_EVENING,
      ports: sendPorts(send),
    });
    expect(result.sent).toBe(1);
    const body = send.mock.calls[0]?.[0]?.text as string;
    expect(body.split('\n')[0]).toBe(
      "Tomorrow: Test has Maya's swim at 3:00pm. Say so here if that changes.",
    );
    expect(body).not.toMatch(/\b(booked|enrolled|signed up)\b/i);
    expect(body).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('suppresses asks 3 to 7 for 30 days after stop asking, and still answers', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const family = await seedFamily(db.database, 'Stop asking');
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, 'chat-stop');
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, SUNDAY_EVENING);
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-stop',
      title: 'Maya swim',
      start: MONDAY,
    });
    await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      parentCount: 2,
      subjectKey: 'evt-stop',
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text',
      now: SUNDAY_EVENING,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    const noted = await answerParentDutyAsk(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      text: 'stop asking',
      now: SUNDAY_EVENING,
    });
    expect(noted).toEqual({ skipped: 'stop_asking' });
    const [fact] = await db.database
      .select({ factValue: schema.familyMemoryFacts.factValue })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, family.familyId),
          eq(schema.familyMemoryFacts.factKey, DUTY_STOP_ASKING_KEY),
        ),
      );
    expect(dutyStopAskingActive(fact?.factValue, SUNDAY_EVENING)).toBe(true);
    const until = new Date((fact?.factValue as { until: string }).until).getTime();
    expect(until - SUNDAY_EVENING.getTime()).toBe(DUTY_STOP_ASKING_MS);
    expect(dutyStopAskingActive(fact?.factValue, new Date(until))).toBe(false);
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: SUNDAY_EVENING,
      bubbleLeaving: true,
    });
    if (!('plan' in view)) throw new Error('expected a plan');
    const modes = [...view.plan.foldLines, ...view.plan.sendLines].map((row) => row.mode);
    expect(modes).toContain('week_overview');
    expect(modes).not.toContain('night_before');
    expect(modes).not.toContain('which_kid');
    expect(modes).not.toContain('both_claimed');
    expect(modes).not.toContain('reask_48h');
    expect(modes).not.toContain('silent_parent');
    const send = vi.fn();
    await sweepDutyAsks(db.database, { now: SUNDAY_EVENING, ports: sendPorts(send) });
    expect(send).not.toHaveBeenCalled();
    const answer = await answerParentDutyAsk(db.database, {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      text: "who's got pickup?",
      now: SUNDAY_EVENING,
      ports: sendPorts(async () => ({ providerMessageId: 'linq-answer' })),
    });
    expect(answer).toMatchObject({ delivery: { status: 'sent' } });
  });

  it('does not enable a single-parent household', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedFamily(db.database, 'Solo');
    await claimGroup(family.familyId, 'chat-solo-parent');
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: SUNDAY_AFTERNOON,
      bubbleLeaving: true,
    });
    expect(view).toEqual({ skipped: 'single_parent' });
  });
});
