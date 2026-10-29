import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import {
  DUTY_STOP_ASKING_KEY,
  DUTY_STOP_ASKING_MS,
  type DutySendPorts,
  answerParentDutyAsk,
  deliverDutyGroupLine,
  dutyStopAskingActive,
  emailDutyInGroup,
  planFamilyDutyAsks,
  renderDutyLines,
  sweepDutyAsks,
} from './asks';
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

/** A model reading. The locked template is not what leaves. */
function scriptedReply(text: string): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ text }) }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: 'end_turn',
      })),
    },
  } as unknown as AgentClient;
}

const MODEL_NIGHT = "Test has Maya's swim at 3:00pm. Say so here if that changes.";

/** Sunday 27 Sep 2026, 15:00 in Toronto. */
const SUNDAY_AFTERNOON = new Date('2026-09-27T19:00:00.000Z');
/** Sunday 27 Sep 2026, 18:00 in Toronto. Inside 17:00–21:00. */
const SUNDAY_EVENING = new Date('2026-09-27T22:00:00.000Z');
const MONDAY = new Date('2026-09-28T19:00:00.000Z');
const TUESDAY = new Date('2026-09-29T19:00:00.000Z');

async function seedDutyFamily(displayName: string) {
  const family = await seedFamily(db.database, displayName);
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, family.parentUserId));
  return family;
}

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
  };
}

describe('duty ask sweep', () => {
  it('is a no-op when the flag is off, including a cancelled duty', async () => {
    const family = await seedDutyFamily('Flag off');
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
    const family = await seedDutyFamily('Two kids');
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

  it("never names a 13+ child or their event in a group duty line, while a younger child's still asks", async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedDutyFamily('Teen in house');
    await secondParent(family.familyId, 'Alex');
    await claimGroup(family.familyId, 'chat-teen');
    await seedChild(db.database, family.familyId, 'Noor', 14 * 12, undefined, SUNDAY_AFTERNOON);
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, SUNDAY_AFTERNOON);
    await seedChild(db.database, family.familyId, 'Leo', 48, undefined, SUNDAY_AFTERNOON);
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-teen-hockey',
      title: 'Noor hockey',
      start: new Date('2026-09-30T19:00:00.000Z'),
    });
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: 'evt-unnamed-swim',
      title: 'Swim',
      start: MONDAY,
    });
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: SUNDAY_AFTERNOON,
      bubbleLeaving: true,
    });
    if (!('plan' in view)) throw new Error('expected a duty plan');
    const text = renderDutyLines(view.plan.foldLines, view.render) ?? '';
    expect(text).toContain('Maya');
    expect(text).not.toContain('Noor');
    expect(text).not.toMatch(/hockey/i);
  });

  it('asks when both parents claim and does not pick a winner', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedDutyFamily('Both claimed');
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
    const family = await seedDutyFamily('Cancelled');
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

  it('never initiates 1:1 when the family has no Linq group', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedDutyFamily('No group');
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
    const family = await seedDutyFamily('Placeholder');
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
        text: 'Tomorrow: {name} has {kid}.',
        now: SUNDAY_EVENING,
        dedupeKey: `duty-ph-${family.familyId}`,
        templateKey: 'linq:group_duty_night_before',
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
    const family = await seedDutyFamily('Group send');
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

  it('sends the composed night-before text', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedDutyFamily('Locked night');
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
    const held = await sweepDutyAsks(db.database, {
      now: SUNDAY_EVENING,
      ports: sendPorts(send),
    });
    expect(held.sent).toBe(0);
    expect(held.held).toBeGreaterThanOrEqual(1);
    expect(send).not.toHaveBeenCalled();
    const result = await sweepDutyAsks(db.database, {
      now: SUNDAY_EVENING,
      ports: sendPorts(send),
      replyClient: scriptedReply(MODEL_NIGHT),
      composeNight: async () => MODEL_NIGHT,
    });
    expect(result.sent).toBe(1);
    const body = send.mock.calls[0]?.[0]?.text as string;
    expect(body).toBe(MODEL_NIGHT);
  });

  it('suppresses asks 3 to 7 for 30 days after stop asking, and still answers', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedDutyFamily('Stop asking');
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
      replyClient: scriptedReply(MODEL_NIGHT),
    });
    expect(answer).toMatchObject({ delivery: { status: 'sent' } });
  });

  it('does not enable a single-parent household', async () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const family = await seedDutyFamily('Solo');
    await claimGroup(family.familyId, 'chat-solo-parent');
    const view = await planFamilyDutyAsks(db.database, {
      familyId: family.familyId,
      now: SUNDAY_AFTERNOON,
      bubbleLeaving: true,
    });
    expect(view).toEqual({ skipped: 'single_parent' });
  });
  /** One duty family with a settled Monday swim on the calendar, and what the
   * night-before composer was handed as its venue. */
  async function venueScenario(input: {
    tag: string;
    bookings: Array<{
      location: string | null;
      linked: 'this' | 'other' | 'none';
      sessionKey?: string | null;
    }>;
    /** Other families joined to this family's group chat, with the sessions they hold. */
    others?: Array<{ sessionKeys: string[] }>;
  }): Promise<unknown[]> {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    const chatId = `chat-venue-${input.tag}`;
    const eventKey = `evt-venue-${input.tag}`;
    const family = await seedDutyFamily(`Venue ${input.tag}`);
    await secondParent(family.familyId, 'Sam');
    await claimGroup(family.familyId, chatId);
    await seedChild(db.database, family.familyId, 'Maya', 36, undefined, SUNDAY_EVENING);
    await kidBlock({
      familyId: family.familyId,
      userId: family.parentUserId,
      eventId: eventKey,
      title: 'Maya swim',
      start: MONDAY,
    });
    const mail = await seedIntegration(db.database, family.familyId, family.parentUserId, 'gmail');
    let index = 0;
    for (const booking of input.bookings) {
      index += 1;
      let eventId: string | null = null;
      if (booking.linked !== 'none') {
        const [row] = await db.database
          .insert(schema.familyEvents)
          .values({
            familyId: family.familyId,
            title: 'Swim level 2',
            startsAt: MONDAY,
            source: 'email',
            googleEventId:
              booking.linked === 'this' ? eventKey : `evt-elsewhere-${input.tag}-${index}`,
          })
          .returning({ id: schema.familyEvents.id });
        eventId = row?.id ?? null;
      }
      await db.database.insert(schema.activityBookings).values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: mail,
        messageId: `msg-venue-${input.tag}-${index}`,
        providerHost: 'pool.example.ca',
        title: 'Swim level 2',
        firstSessionAt: MONDAY,
        location: booking.location,
        sessionKey: booking.sessionKey ?? null,
        eventId,
      });
    }
    for (const [n, other] of (input.others ?? []).entries()) {
      const neighbour = await seedDutyFamily(`Venue ${input.tag} neighbour ${n}`);
      await db.database.insert(schema.linqMultiFamilyJoins).values({
        chatId,
        familyId: neighbour.familyId,
        joinedAt: SUNDAY_AFTERNOON,
      });
      const theirMail = await seedIntegration(
        db.database,
        neighbour.familyId,
        neighbour.parentUserId,
        'gmail',
      );
      for (const [m, sessionKey] of other.sessionKeys.entries()) {
        await db.database.insert(schema.activityBookings).values({
          familyId: neighbour.familyId,
          parentUserId: neighbour.parentUserId,
          integrationId: theirMail,
          messageId: `msg-neighbour-${input.tag}-${n}-${m}`,
          providerHost: 'pool.example.ca',
          title: 'Swim level 2',
          firstSessionAt: MONDAY,
          location: 'Their own pool',
          sessionKey,
        });
      }
    }
    await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      parentCount: 2,
      subjectKey: eventKey,
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
    const seen: unknown[] = [];
    await sweepDutyAsks(db.database, {
      now: SUNDAY_EVENING,
      ports: sendPorts(vi.fn(async () => ({ providerMessageId: `linq-${input.tag}` }))),
      replyClient: scriptedReply(MODEL_NIGHT),
      composeNight: async (_client, facts, familyId) => {
        if (familyId === family.familyId) seen.push(facts.handoff?.venue);
        return MODEL_NIGHT;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    return [...new Set(seen.map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v));
  }

  const POOL = 'Pan Am Centre pool';
  const SESSION = 'pool.example.ca|swim level 2|2026-09-28T19:00:00.000Z';

  it('hands the venue name from a booking linked to this event, with no invented address', async () => {
    expect(
      await venueScenario({ tag: 'own', bookings: [{ location: POOL, linked: 'this' }] }),
    ).toEqual([{ name: POOL, address: null }]);
  });

  it('hands no venue when the linked booking has no location', async () => {
    expect(
      await venueScenario({ tag: 'blank', bookings: [{ location: null, linked: 'this' }] }),
    ).toEqual([null]);
  });

  it('never lets an unrelated booking at the same start time lend its venue', async () => {
    expect(
      await venueScenario({
        tag: 'unrelated',
        bookings: [
          { location: 'Some other gym', linked: 'other' },
          { location: 'Unlinked arena', linked: 'none' },
        ],
      }),
    ).toEqual([null]);
  });

  it('never sends one family’s venue into a multi-family group for an event only they have', async () => {
    expect(
      await venueScenario({
        tag: 'multi-private',
        bookings: [{ location: POOL, linked: 'this', sessionKey: SESSION }],
        others: [{ sessionKeys: ['pool.example.ca|piano|2026-09-28T19:00:00.000Z'] }],
      }),
    ).toEqual([null]);
  });

  it('sends the venue into a multi-family group only for the activity the group shares', async () => {
    expect(
      await venueScenario({
        tag: 'multi-shared',
        bookings: [{ location: POOL, linked: 'this', sessionKey: SESSION }],
        others: [{ sessionKeys: [SESSION] }],
      }),
    ).toEqual([{ name: POOL, address: null }]);
  });
});
