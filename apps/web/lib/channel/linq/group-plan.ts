import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import { type ActivityFinder, createActivityFinder } from '~/lib/channel/activity/lane';
import {
  bindActivityReader,
  productionActivityFamilyReader,
} from '~/lib/channel/activity/reader';
import { speak } from '~/lib/channel/spoken-line';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { deliverLinqGroupNotice } from './group';
import { groupMemberByPhone, readGroupMembership } from './group-membership';
import {
  type GroupPlanReader,
  sharedGroupPlanReader,
  stanceFromReading,
} from './group-plan-reader';

export type GroupPlanOption = {
  id: string;
  name: string;
  when: string | null;
  where: string | null;
  price: string | null;
  link: string | null;
};

/**
 * VIL-441 (T14) — plan together, get everyone to a yes.
 *
 * Find options (the 1:1 activity search), post them as one AI-written bubble,
 * read free text and tapbacks as yes / no / maybe, follow up once with people
 * who have not answered. No poll cards. No fixed copy. A failed model write
 * sends nothing.
 */

export type GroupPlanSend = (input: {
  chatId: string;
  text: string;
}) => Promise<{ providerMessageId: string }>;

export type GroupPlanFinderReason = 'not_configured' | 'failed' | 'empty' | 'refused';

export type GroupPlanFinderResult =
  | { found: true; options: GroupPlanOption[] }
  | { found: false; reason: GroupPlanFinderReason };

export interface GroupPlanFinder {
  find(input: { subject: string; familyId: string }): Promise<GroupPlanFinderResult>;
}

export type GroupPlanTurnOutcome =
  | { handled: false; outcome: 'not_a_plan_turn' }
  | { handled: true; outcome: 'group_plan_posted'; notice: 'sent' | 'not_sent' | 'model_unreachable' }
  | { handled: true; outcome: 'group_plan_finder_unavailable'; reason: GroupPlanFinderReason }
  | { handled: true; outcome: 'group_plan_vote'; seated: boolean; stance: 'yes' | 'no' | 'maybe'; spoke: boolean }
  | { handled: true; outcome: 'group_plan_unread' }
  | { handled: true; outcome: 'group_plan_followed_up'; notice: 'sent' | 'not_sent' | 'model_unreachable' }
  | { handled: true; outcome: 'group_plan_progress'; notice: 'sent' | 'not_sent' | 'model_unreachable' };

export type GroupPlanPorts = {
  now: Date;
  language: string | null;
  send?: GroupPlanSend;
  reader?: GroupPlanReader;
  finder?: GroupPlanFinder;
};

const DEFAULT_DEADLINE_MS = 48 * 60 * 60 * 1000;

export async function loadOpenPlan(
  database: Database,
  chatId: string,
): Promise<(typeof schema.linqGroupPlans.$inferSelect) | null> {
  const [row] = await database
    .select()
    .from(schema.linqGroupPlans)
    .where(and(eq(schema.linqGroupPlans.chatId, chatId), eq(schema.linqGroupPlans.status, 'open')))
    .limit(1);
  return row ?? null;
}

export async function loadPlanAnswers(
  database: Database,
  planId: string,
): Promise<(typeof schema.linqGroupPlanAnswers.$inferSelect)[]> {
  return database
    .select()
    .from(schema.linqGroupPlanAnswers)
    .where(eq(schema.linqGroupPlanAnswers.planId, planId));
}

export function unansweredMembers(
  members: readonly { userId: string; name: string | null }[],
  answers: readonly { userId: string | null; seated: string }[],
): { userId: string; name: string | null }[] {
  const answered = new Set(
    answers.filter((row) => row.seated === 'yes' && row.userId).map((row) => row.userId as string),
  );
  return members.filter((member) => !answered.has(member.userId));
}

export function winningOption(
  options: readonly GroupPlanOption[],
  answers: readonly { seated: string; stance: string; optionId: string | null }[],
): GroupPlanOption | null {
  const counts = new Map<string, number>();
  for (const answer of answers) {
    if (answer.seated !== 'yes' || answer.stance !== 'yes' || !answer.optionId) continue;
    counts.set(answer.optionId, (counts.get(answer.optionId) ?? 0) + 1);
  }
  let best: { id: string; n: number } | null = null;
  for (const [id, n] of counts) {
    if (!best || n > best.n) best = { id, n };
  }
  if (!best) return null;
  return options.find((option) => option.id === best?.id) ?? null;
}

export function planFacts(input: {
  topic: string;
  options: readonly GroupPlanOption[];
  deadline: string | null;
  yes: readonly string[];
  no: readonly string[];
  maybe: readonly string[];
  unanswered: readonly string[];
  winning: string | null;
}): Record<string, string> {
  const optionLines = input.options.map((option, index) => {
    const bits = [option.name, option.when, option.where, option.price, option.link].filter(
      (bit): bit is string => typeof bit === 'string' && bit.length > 0,
    );
    return `${index + 1}. ${bits.join(' · ')}`;
  });
  return {
    topic: input.topic,
    options: optionLines.join('\n'),
    deadline: input.deadline ?? '',
    yes: input.yes.join(', '),
    no: input.no.join(', '),
    maybe: input.maybe.join(', '),
    unanswered: input.unanswered.join(', '),
    winning: input.winning ?? '',
  };
}

export async function recordPlanAnswer(
  database: Database,
  input: {
    planId: string;
    familyId: string;
    phoneE164Hash: string;
    userId: string | null;
    displayName: string | null;
    seated: boolean;
    stance: 'yes' | 'no' | 'maybe';
    optionId: string | null;
    source: 'text' | 'tapback';
    verbatim: string;
    interpretation: string;
    now: Date;
  },
): Promise<'inserted' | 'updated'> {
  const existing = await database
    .select({ id: schema.linqGroupPlanAnswers.id })
    .from(schema.linqGroupPlanAnswers)
    .where(
      and(
        eq(schema.linqGroupPlanAnswers.planId, input.planId),
        eq(schema.linqGroupPlanAnswers.phoneE164Hash, input.phoneE164Hash),
      ),
    )
    .limit(1);
  const values = {
    planId: input.planId,
    phoneE164Hash: input.phoneE164Hash,
    userId: input.userId,
    displayName: input.displayName,
    seated: input.seated ? ('yes' as const) : ('no' as const),
    stance: input.stance,
    optionId: input.optionId,
    source: input.source,
    verbatim: input.verbatim,
    interpretation: input.interpretation,
    updatedAt: input.now,
  };
  const audit = {
    familyId: input.familyId,
    actor: input.userId ?? 'system',
    actionTaken: 'linq_group_plan_answer' as const,
    targetTable: 'linq_group_plan_answers' as const,
    targetId: input.planId,
    after: {
      stance: input.stance,
      seated: input.seated,
      source: input.source,
      optionId: input.optionId,
    },
  };
  if (existing[0]) {
    await database
      .update(schema.linqGroupPlanAnswers)
      .set(values)
      .where(eq(schema.linqGroupPlanAnswers.id, existing[0].id));
    await database.insert(schema.auditLog).values(audit);
    return 'updated';
  }
  await database.insert(schema.linqGroupPlanAnswers).values({ ...values, createdAt: input.now });
  await database.insert(schema.auditLog).values(audit);
  return 'inserted';
}

async function memberNames(
  database: Database,
  membership: { members: readonly { userId: string }[] },
): Promise<{ userId: string; name: string | null }[]> {
  if (membership.members.length === 0) return [];
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users);
  const byId = new Map(rows.map((row) => [row.id, row.name?.trim().split(/\s+/)[0] || null]));
  return membership.members.map((member) => ({
    userId: member.userId,
    name: byId.get(member.userId) ?? null,
  }));
}

function named(rows: readonly { displayName: string | null; stance: string; seated: string }[]) {
  const yes: string[] = [];
  const no: string[] = [];
  const maybe: string[] = [];
  for (const row of rows) {
    if (row.seated !== 'yes') continue;
    const name = row.displayName?.trim() || null;
    if (!name) continue;
    if (row.stance === 'yes') yes.push(name);
    else if (row.stance === 'no') no.push(name);
    else maybe.push(name);
  }
  return { yes, no, maybe };
}

async function composeAndSend(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    purpose: 'group_plan_options' | 'group_plan_followup' | 'group_plan_progress';
    language: string | null;
    facts: Record<string, string>;
    verbatim: readonly string[];
    now: Date;
    send?: GroupPlanSend;
    templateKey: string;
  },
): Promise<{ notice: 'sent' | 'not_sent' | 'model_unreachable'; providerMessageId: string | null }> {
  const text = await speak({
    purpose: input.purpose,
    language: input.language,
    facts: input.facts,
    verbatim: input.verbatim.filter((piece) => piece.length > 0),
  });
  if (!text) return { notice: 'model_unreachable', providerMessageId: null };
  const notice = await deliverLinqGroupNotice(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    text,
    templateKey: input.templateKey,
    now: input.now,
    send: input.send,
  });
  if (notice !== 'sent') return { notice: 'not_sent', providerMessageId: null };
  return { notice: 'sent', providerMessageId: null };
}

export async function openGroupPlan(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    topic: string;
    options: readonly GroupPlanOption[];
    language: string | null;
    now: Date;
    deadlineAt?: Date;
    send?: GroupPlanSend;
  },
): Promise<
  | { outcome: 'group_plan_posted'; planId: string; notice: 'sent' | 'not_sent' | 'model_unreachable' }
  | { outcome: 'group_plan_unsent'; reason: 'no_options' | 'model_unreachable' }
> {
  if (input.options.length === 0) return { outcome: 'group_plan_unsent', reason: 'no_options' };
  const facts = planFacts({
    topic: input.topic,
    options: input.options,
    deadline: input.deadlineAt ? input.deadlineAt.toISOString() : null,
    yes: [],
    no: [],
    maybe: [],
    unanswered: [],
    winning: null,
  });
  const verbatim = input.options.flatMap((option) =>
    [option.name, option.when, option.where, option.price, option.link].filter(
      (bit): bit is string => typeof bit === 'string' && bit.length > 0,
    ),
  );
  const text = await speak({
    purpose: 'group_plan_options',
    language: input.language,
    facts,
    verbatim,
  });
  if (!text) return { outcome: 'group_plan_unsent', reason: 'model_unreachable' };
  const [plan] = await database
    .insert(schema.linqGroupPlans)
    .values({
      familyId: input.familyId,
      chatId: input.chatId,
      topic: input.topic,
      options: [...input.options],
      deadlineAt: input.deadlineAt ?? new Date(input.now.getTime() + DEFAULT_DEADLINE_MS),
      status: 'open',
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: schema.linqGroupPlans.id });
  const planId = plan?.id;
  if (!planId) return { outcome: 'group_plan_unsent', reason: 'no_options' };
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'linq_group_plan_opened',
    targetTable: 'linq_group_plans',
    targetId: planId,
    after: { topic: input.topic, optionCount: input.options.length },
  });
  const notice = await deliverLinqGroupNotice(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    text,
    templateKey: 'linq:group_plan_options',
    now: input.now,
    send: input.send,
  });
  if (notice === 'sent') {
    // The capture / test send returns a provider id; production does too.
    // We do not invent one when the notice path hid it.
  }
  return {
    outcome: 'group_plan_posted',
    planId,
    notice: notice === 'sent' ? 'sent' : 'not_sent',
  };
}

export async function followUpUnanswered(
  database: Database,
  input: {
    plan: typeof schema.linqGroupPlans.$inferSelect;
    members: readonly { userId: string; name: string | null }[];
    answers: readonly {
      userId: string | null;
      seated: string;
      stance: string;
      displayName: string | null;
    }[];
    language: string | null;
    now: Date;
    send?: GroupPlanSend;
    parentUserId: string;
  },
): Promise<{ outcome: 'group_plan_followed_up' | 'already_followed_up' | 'no_one_waiting'; notice?: 'sent' | 'not_sent' | 'model_unreachable' }> {
  if (input.plan.followedUpAt) return { outcome: 'already_followed_up' };
  const waiting = unansweredMembers(input.members, input.answers);
  if (waiting.length === 0) return { outcome: 'no_one_waiting' };
  const names = named(input.answers);
  const facts = planFacts({
    topic: input.plan.topic,
    options: input.plan.options,
    deadline: input.plan.deadlineAt?.toISOString() ?? null,
    yes: names.yes,
    no: names.no,
    maybe: names.maybe,
    unanswered: waiting.map((member) => member.name).filter((name): name is string => !!name),
    winning: winningOption(input.plan.options, input.answers)?.name ?? null,
  });
  const sent = await composeAndSend(database, {
    familyId: input.plan.familyId,
    parentUserId: input.parentUserId,
    chatId: input.plan.chatId,
    purpose: 'group_plan_followup',
    language: input.language,
    facts,
    verbatim: facts.unanswered.split(', ').filter(Boolean),
    now: input.now,
    send: input.send,
    templateKey: 'linq:group_plan_followup',
  });
  if (sent.notice === 'sent') {
    await database
      .update(schema.linqGroupPlans)
      .set({ followedUpAt: input.now, updatedAt: input.now })
      .where(eq(schema.linqGroupPlans.id, input.plan.id));
    await database.insert(schema.auditLog).values({
      familyId: input.plan.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_group_plan_followed_up',
      targetTable: 'linq_group_plans',
      targetId: input.plan.id,
      after: { unanswered: facts.unanswered },
    });
  }
  return { outcome: 'group_plan_followed_up', notice: sent.notice };
}

async function maybeProgress(
  database: Database,
  input: {
    plan: typeof schema.linqGroupPlans.$inferSelect;
    members: readonly { userId: string; name: string | null }[];
    answers: readonly {
      userId: string | null;
      seated: string;
      stance: string;
      optionId: string | null;
      displayName: string | null;
    }[];
    language: string | null;
    now: Date;
    send?: GroupPlanSend;
    parentUserId: string;
  },
): Promise<{ spoke: boolean; notice?: 'sent' | 'not_sent' | 'model_unreachable' }> {
  const waiting = unansweredMembers(input.members, input.answers);
  if (waiting.length > 0) return { spoke: false };
  const names = named(input.answers);
  const win = winningOption(input.plan.options, input.answers);
  const facts = planFacts({
    topic: input.plan.topic,
    options: input.plan.options,
    deadline: input.plan.deadlineAt?.toISOString() ?? null,
    yes: names.yes,
    no: names.no,
    maybe: names.maybe,
    unanswered: [],
    winning: win?.name ?? null,
  });
  const sent = await composeAndSend(database, {
    familyId: input.plan.familyId,
    parentUserId: input.parentUserId,
    chatId: input.plan.chatId,
    purpose: 'group_plan_progress',
    language: input.language,
    facts,
    verbatim: [win?.name, ...names.yes, ...names.no, ...names.maybe].filter(
      (bit): bit is string => typeof bit === 'string' && bit.length > 0,
    ),
    now: input.now,
    send: input.send,
    templateKey: 'linq:group_plan_progress',
  });
  if (win && sent.notice === 'sent') {
    await database
      .update(schema.linqGroupPlans)
      .set({ status: 'settled', settledOptionId: win.id, updatedAt: input.now })
      .where(eq(schema.linqGroupPlans.id, input.plan.id));
    await database.insert(schema.auditLog).values({
      familyId: input.plan.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_group_plan_settled',
      targetTable: 'linq_group_plans',
      targetId: input.plan.id,
      after: { optionId: win.id },
    });
  }
  return { spoke: sent.notice !== 'model_unreachable', notice: sent.notice };
}

export async function takeGroupPlanTurn(
  database: Database,
  input: {
    chatId: string;
    senderHandle: string;
    text: string;
    reactionType?: string | null;
    providerMessageId?: string | null;
    ports: GroupPlanPorts;
  },
): Promise<GroupPlanTurnOutcome> {
  const membership = await readGroupMembership(database, input.chatId);
  if (!membership) return { handled: false, outcome: 'not_a_plan_turn' };

  const phone = normalizePhoneE164(input.senderHandle);
  if (!phone) return { handled: false, outcome: 'not_a_plan_turn' };
  const hash = phoneBlindIndex(phone);
  const seatedMember = await groupMemberByPhone(database, input.chatId, input.senderHandle);
  const names = await memberNames(database, membership);
  const senderName =
    seatedMember ? (names.find((row) => row.userId === seatedMember.userId)?.name ?? null) : null;

  const plan = await loadOpenPlan(database, input.chatId);
  const answers = plan ? await loadPlanAnswers(database, plan.id) : [];
  const reader = input.ports.reader ?? sharedGroupPlanReader();

  if (plan) {
    const reading = await reader.read({
      text: input.text,
      reactionType: input.reactionType ?? null,
      senderName,
      options: plan.options,
      answered: answers.map((row) => ({ name: row.displayName, stance: row.stance })),
    });
    if (!reading) return { handled: true, outcome: 'group_plan_unread' };
    const vote = stanceFromReading(reading);
    const due =
      !vote &&
      plan.deadlineAt &&
      !plan.followedUpAt &&
      input.ports.now.getTime() >= plan.deadlineAt.getTime();
    if (due) {
      const follow = await followUpUnanswered(database, {
        plan,
        members: names,
        answers,
        language: input.ports.language,
        now: input.ports.now,
        send: input.ports.send,
        parentUserId: membership.members[0]?.userId ?? seatedMember?.userId ?? 'system',
      });
      if (follow.outcome === 'group_plan_followed_up') {
        return {
          handled: true,
          outcome: 'group_plan_followed_up',
          notice: follow.notice ?? 'not_sent',
        };
      }
    }
    if (!vote) return { handled: false, outcome: 'not_a_plan_turn' };

    const optionId =
      vote.optionId && plan.options.some((option) => option.id === vote.optionId)
        ? vote.optionId
        : null;
    await recordPlanAnswer(database, {
      planId: plan.id,
      familyId: membership.familyId,
      phoneE164Hash: hash,
      userId: seatedMember?.userId ?? null,
      displayName: senderName,
      seated: !!seatedMember,
      stance: vote.stance,
      optionId,
      source: input.reactionType ? 'tapback' : 'text',
      verbatim: input.reactionType ? `tapback:${input.reactionType}` : input.text,
      interpretation: reading.intent,
      now: input.ports.now,
    });

    const nextAnswers = await loadPlanAnswers(database, plan.id);
    const progress = seatedMember
      ? await maybeProgress(database, {
          plan,
          members: names,
          answers: nextAnswers,
          language: input.ports.language,
          now: input.ports.now,
          send: input.ports.send,
          parentUserId: seatedMember.userId,
        })
      : { spoke: false };
    return {
      handled: true,
      outcome: progress.spoke ? 'group_plan_progress' : 'group_plan_vote',
      seated: !!seatedMember,
      stance: vote.stance,
      spoke: progress.spoke,
    };
  }

  if (!seatedMember) return { handled: false, outcome: 'not_a_plan_turn' };

  const reading = await reader.read({
    text: input.text,
    reactionType: input.reactionType ?? null,
    senderName,
    options: [],
    answered: [],
  });
  if (!reading) return { handled: true, outcome: 'group_plan_unread' };
  if (reading.intent !== 'plan_ask' || reading.confidence !== 'high' || !reading.subject) {
    return { handled: false, outcome: 'not_a_plan_turn' };
  }

  const finder = input.ports.finder ?? productionGroupPlanFinder(database);
  const found = await finder.find({ subject: reading.subject, familyId: membership.familyId });
  if (!found.found) {
    await database.insert(schema.auditLog).values({
      familyId: membership.familyId,
      actor: seatedMember.userId,
      actionTaken: 'linq_group_plan_finder_unavailable',
      targetTable: 'linq_group_plans',
      targetId: membership.familyId,
      after: { reason: found.reason },
    });
    return { handled: true, outcome: 'group_plan_finder_unavailable', reason: found.reason };
  }

  const opened = await openGroupPlan(database, {
    familyId: membership.familyId,
    parentUserId: seatedMember.userId,
    chatId: input.chatId,
    topic: reading.subject,
    options: found.options,
    language: input.ports.language,
    now: input.ports.now,
    send: input.ports.send,
  });
  if (opened.outcome === 'group_plan_unsent') {
    return { handled: true, outcome: 'group_plan_posted', notice: 'model_unreachable' };
  }
  return { handled: true, outcome: 'group_plan_posted', notice: opened.notice };
}

export function optionsFromPicks(
  picks: readonly {
    name: string;
    when: string | null;
    price: string | null;
    sourceName: string;
    url?: string;
    sourceUrl?: string;
  }[],
): GroupPlanOption[] {
  return picks.slice(0, 3).map((pick, index) => ({
    id: String(index + 1),
    name: pick.name,
    when: pick.when,
    where: pick.sourceName,
    price: pick.price,
    link: pick.url ?? pick.sourceUrl ?? null,
  }));
}

export function createActivityGroupPlanFinder(
  finder: ActivityFinder,
  reader: ReturnType<typeof bindActivityReader>,
): GroupPlanFinder {
  return {
    async find(input) {
      const [municipality, stage, householdNames] = await Promise.all([
        reader.municipality(input.familyId),
        reader.stage(input.familyId, null),
        reader.householdNames(input.familyId),
      ]);
      const deidentified = deidentifyActivityQuery({
        subject: input.subject,
        window: null,
        municipality,
        stage,
        householdNames,
      });
      if (!deidentified.ok) return { found: false, reason: 'refused' };
      const result = await finder.find(deidentified.query);
      if (!result.found) {
        if (result.reason === 'no_picks') return { found: false, reason: 'empty' };
        if (result.reason === 'client_unavailable' || result.reason === 'skill_unavailable') {
          return { found: false, reason: 'not_configured' };
        }
        return { found: false, reason: 'failed' };
      }
      const options = optionsFromPicks(result.picks);
      if (options.length === 0) return { found: false, reason: 'empty' };
      return { found: true, options };
    },
  };
}

export function productionGroupPlanFinder(database: Database): GroupPlanFinder {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      async find() {
        return { found: false, reason: 'not_configured' };
      },
    };
  }
  return createActivityGroupPlanFinder(
    createActivityFinder(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS)),
    bindActivityReader(database, productionActivityFamilyReader()),
  );
}

export function sharedGroupPlanFinder(): GroupPlanFinder {
  return {
    async find() {
      return { found: false, reason: 'not_configured' };
    },
  };
}

/** Test / preview seam: a finder that returns the given options and never searches. */
export function fakeGroupPlanFinder(
  options: readonly GroupPlanOption[] | GroupPlanFinderResult,
): GroupPlanFinder & { calls: { subject: string; familyId: string }[] } {
  const calls: { subject: string; familyId: string }[] = [];
  return {
    calls,
    async find(input) {
      calls.push(input);
      if (Array.isArray(options)) {
        return options.length > 0
          ? { found: true, options: [...options] }
          : { found: false, reason: 'empty' };
      }
      return options;
    },
  };
}

export function fakeGroupPlanReader(
  resolve: (input: { text: string; reactionType: string | null }) => GroupPlanReading | null,
): GroupPlanReader & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      return resolve({ text: input.text, reactionType: input.reactionType });
    },
  };
}
