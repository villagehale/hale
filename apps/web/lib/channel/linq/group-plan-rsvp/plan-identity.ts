import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { GroupPlanReadView } from './reading';
import type { GroupPlanRecord } from './store';
import type { PlanTally } from './tally';

/**
 * VIL-689 · the one plan-identity rule for group chats.
 *
 * A chat may hold several open plans. A vote, lock, RSVP or calendar copy names its plan by
 * an id code resolved: the poll row's plan, the Hale line a tapback landed on, or a plan the
 * reader matched by its opaque key and code found among the open plans. Never "whatever plan
 * is open in the chat": when code cannot resolve one, nothing binds.
 */
export type PlanRef =
  /** An open plan in this chat, by id. */
  | { status: 'plan'; planId: string }
  /** About an event no open plan is. */
  | { status: 'other' }
  /** Could be more than one open plan: nothing binds, and Hale may ask which. */
  | { status: 'unclear' }
  /** Not about a plan, or none is open. */
  | { status: 'none' };

const OTHER = 'other';
const UNCLEAR = 'unclear';

export function planKeyAt(index: number): string {
  return `p${index + 1}`;
}

/** The open plans as the reader sees them, keyed `p1`… in the order given (newest first). */
export function planReadViews(
  plans: readonly { plan: GroupPlanRecord; tally: PlanTally | null }[],
): GroupPlanReadView[] {
  return plans.map(({ plan, tally }, index) => ({
    key: planKeyAt(index),
    title: plan.title,
    startsAt: plan.startsAt?.toISOString() ?? null,
    deadline: plan.rsvpDeadlineAt?.toISOString() ?? null,
    yesNames: tally?.yesNames ?? [],
    waitingNames: tally?.waitingNames ?? [],
  }));
}

/** The reader's key, checked against the plans it was shown. A key it was not shown binds nothing. */
export function resolvePlanKey(
  key: string | null | undefined,
  plans: readonly GroupPlanRecord[],
): PlanRef {
  const value = key?.trim() ?? '';
  if (!value) return { status: 'none' };
  if (value === OTHER) return { status: 'other' };
  if (value === UNCLEAR) return { status: 'unclear' };
  const index = plans.findIndex((_, at) => planKeyAt(at) === value);
  const plan = index >= 0 ? plans[index] : undefined;
  return plan ? { status: 'plan', planId: plan.id } : { status: 'none' };
}

export function refPlanId(ref: PlanRef | null | undefined): string | null {
  return ref?.status === 'plan' ? ref.planId : null;
}

/** The dedupe key of a Hale group line about a plan carries that plan's id. */
export function groupPlanLineDedupeKey(input: {
  templateKey: string;
  chatId: string;
  planId: string | null;
  now: Date;
}): string {
  const plan = input.planId ? `:plan:${input.planId}` : '';
  return `${input.templateKey}:${input.chatId}${plan}:${input.now.toISOString()}`;
}

const PLAN_IN_KEY = /:plan:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;

/**
 * The plan a Hale group line in this chat was about, read from its own ledger row. A reaction
 * on that line is about that plan; a reaction on anything else is about none.
 */
export async function planIdOfGroupLine(
  database: Database,
  input: { chatId: string; providerMessageId: string; templateKeys: readonly string[] },
): Promise<string | null> {
  const [row] = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerChatId, input.chatId),
        eq(schema.channelMessages.providerMessageId, input.providerMessageId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.templateKey, [...input.templateKeys]),
      ),
    )
    .limit(1);
  return row?.dedupeKey?.match(PLAN_IN_KEY)?.[1] ?? null;
}
