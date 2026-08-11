import { type Database, type UnmetIntentCategory, type UnmetIntentLane, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { AgentClient } from '@hale/agent';
import { PROVIDER_ACCESS_REPLY, SAFETY_REPLY, offDomainReply } from './copy';
import {
  type InboundLaneScreen,
  type LaneScreenFallback,
  createInboundLaneScreen,
} from './screen';

/**
 * VIL-273 — the off-domain capability lane, end to end minus the sending.
 *
 * Hale is a chief of staff, not an event finder and not a search box (founder policy,
 * live gate day 1). Three kinds of text therefore have a right answer that no model
 * needs to be woken for: a question about the world, a question about a symptom, and a
 * parent trying to get a doctor. This module turns one inbound message into whichever
 * of those it is, the fixed line that answers it, and a countable demand signal — and
 * the router does the rest.
 *
 * WHY THE SIGNAL LIVES HERE AND NOT IN THE ROUTER. A deflection is the only outcome in
 * the whole inbound path where Hale says no, and the ONE thing worth knowing about it
 * is what was asked. Recording that is not the router's business (it deals in threads,
 * ledgers and audit rows); it is the last step of deciding to deflect. Keeping the two
 * in one call is also what makes the count trustworthy: there is no path that sends a
 * deflection without producing a signal, because it is the same return value.
 *
 * Rule #11 all the way down. The screen's degraded paths come back NAMED
 * ({@link LaneScreenFallback}), the record's outcome comes back NAMED
 * ({@link UnmetSignalOutcome}), and neither can be silent. A signal that failed to
 * write must never cost a parent their reply, so the write is best-effort and says so
 * out loud rather than throwing.
 */

/** Whether the demand signal actually landed. `not_recorded` is a real, countable
 * outcome — the deflection still went out, and the founder's weekly count is short one
 * row that the log line accounts for. */
export type UnmetSignalOutcome = 'recorded' | 'not_recorded';

export type OffDomainVerdict =
  /** Hale's job. The turn continues to the coach exactly as it did before this stage
   * existed — carrying WHY, when the screen could not run (rule #11). */
  | { status: 'in_domain'; fallback: LaneScreenFallback | null }
  /** Not Hale's job, and here is the fixed line that says so. */
  | {
      status: 'deflected';
      lane: UnmetIntentLane;
      category: UnmetIntentCategory;
      reply: string;
      signal: UnmetSignalOutcome;
    };

export interface OffDomainPorts {
  screen: InboundLaneScreen;
  /**
   * How many actions are waiting on this family's OK right now — the only true thing
   * the charm deflect is allowed to add, and only ever as a count.
   *
   * Read LAZILY by {@link offDomainLane}: it is asked only once a message is known to
   * be off-domain, so the overwhelmingly common in-domain turn pays nothing for it.
   */
  pendingApprovals(familyId: string): Promise<number>;
  /** Stamps the inbound row with the lane + bucket. Never throws — see
   * {@link UnmetSignalOutcome}. */
  recordUnmetIntent(input: {
    channelMessageId: string;
    familyId: string;
    lane: UnmetIntentLane;
    category: UnmetIntentCategory;
  }): Promise<UnmetSignalOutcome>;
}

export interface OffDomainLane {
  consider(input: {
    familyId: string;
    channelMessageId: string;
    text: string;
  }): Promise<OffDomainVerdict>;
}

export function offDomainLane(ports: OffDomainPorts): OffDomainLane {
  return {
    async consider(input) {
      const reading = await ports.screen.read(input.text);
      if (reading.lane === 'in_domain' || reading.category === null) {
        return { status: 'in_domain', fallback: reading.fallback };
      }
      const lane = reading.lane;

      // The pending count is read for the charm deflect ONLY. The other two lanes are
      // fixed sentences on purpose: appending "and 2 things are waiting on your OK" to
      // an answer about a child's head injury would be the worst sentence Hale ever
      // sent, and the way to make that impossible is for the fact never to be fetched.
      const reply =
        lane === 'safety_critical'
          ? SAFETY_REPLY
          : lane === 'provider_access'
            ? PROVIDER_ACCESS_REPLY
            : offDomainReply({ pendingApprovals: await ports.pendingApprovals(input.familyId) });

      const signal = await ports.recordUnmetIntent({
        channelMessageId: input.channelMessageId,
        familyId: input.familyId,
        lane,
        category: reading.category,
      });

      return { status: 'deflected', lane, category: reading.category, reply, signal };
    },
  };
}

/**
 * The demand-signal write: two columns on the inbound row the parent's message already
 * occupies (migration 0080).
 *
 * The family id is in the WHERE clause as well as the id, matching the router's own
 * rule-#1 backstop in loadInboundContext: the only thing asserting whose message this
 * is came off a queue, and a mismatch must stamp nothing rather than attribute one
 * family's question to another's week.
 *
 * Best-effort by construction. This is telemetry sitting between a parent's question
 * and Hale's answer; a dead index or a locked row is not a reason for them to hear
 * nothing back, so the failure is caught, named and counted rather than thrown. The
 * catch is deliberately broad for that reason and that reason only — it is the boundary,
 * not business logic.
 */
export function recordUnmetIntent(database: Database) {
  return async (input: {
    channelMessageId: string;
    familyId: string;
    lane: UnmetIntentLane;
    category: UnmetIntentCategory;
  }): Promise<UnmetSignalOutcome> => {
    try {
      const updated = await database
        .update(schema.channelMessages)
        .set({ unmetLane: input.lane, unmetCategory: input.category })
        .where(
          and(
            eq(schema.channelMessages.id, input.channelMessageId),
            eq(schema.channelMessages.familyId, input.familyId),
          ),
        )
        .returning({ id: schema.channelMessages.id });
      if (updated.length > 0) return 'recorded';
      console.error(
        { channelMessageId: input.channelMessageId, lane: input.lane },
        'off-domain lane: unmet-intent stamp matched no row',
      );
      return 'not_recorded';
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.message : 'unknown', lane: input.lane },
        'off-domain lane: unmet-intent stamp failed',
      );
      return 'not_recorded';
    }
  };
}

/**
 * The production lane. `pendingApprovals` is passed in rather than queried here so it
 * can be bound to the SAME read the approval grammar resolves ordinals against — see
 * router/wiring.ts. One reader, one answer: the number in the deflect and the list a
 * "YES 1" would hit can never disagree.
 */
export function productionOffDomainLane(
  database: Database,
  client: () => AgentClient,
  pendingApprovals: (familyId: string) => Promise<number>,
): OffDomainLane {
  return offDomainLane({
    screen: createInboundLaneScreen(client),
    pendingApprovals,
    recordUnmetIntent: recordUnmetIntent(database),
  });
}
