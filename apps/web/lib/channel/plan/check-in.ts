import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { f14Enabled, f14Allowlist } from '~/lib/channel/f14';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { type DueCommitment, fulfillCommitment, loadDueCommitments } from '~/lib/commitments/ledger';
import { appendMessage } from '~/lib/coach/conversation';
import { type NoteComposer, createNoteComposer } from './note';
import { isPlanTopic, weekdayIn } from './topics';
import { playbookFor } from '@hale/types';
import { pipelineClient } from '~/lib/pipeline/client';

/**
 * THE CHECK-IN — step four, and the only unprompted message in this arc.
 *
 * A few days after a full plan goes out — on the day the plan PROMISED — Hale asks how
 * it went. One composed text. That is the whole feature, and the restraint is the
 * point: a plan that lands and is never followed up is advice, while a plan someone
 * comes back about is a chief of staff.
 *
 * COMPOSED, NOT A TEMPLATE. This shipped once as seven fixed sentences, one per topic,
 * and they were good sentences — which is the problem. A preset body is a sentence
 * nobody is writing for THIS family, and the check-in is the message with the most to
 * gain from being written for them: it knows the method they ran and the day they were
 * promised. A gate refusal is recomposed; exhausting the attempts leaves the promise
 * OPEN for the next tick rather than sending something canned.
 *
 * IT RIDES THE HOURLY NUDGE CRON, the way village intros do, and for the same reasons:
 * that cron already exists to decide whether to interrupt a parent, it already runs at
 * the cadence this needs, and a second Vercel slot would be a second failure budget and
 * a second place to forget the dark-launch flag.
 *
 * NO HOUR SLOT OF ITS OWN. The gate's quiet hours (21:00-08:00 local) are the timing
 * policy, and the ledger is the volume policy — one open check-in per family, minted
 * only by a plan the parent asked for. A "only at 11am" gate would add nothing a parent
 * can feel while making the loop untestable in any run that does not start at 11am.
 *
 * THE LEDGER IS THE STATE MACHINE. Due is a query (`due_at <= now` on an open row),
 * sent-once is the dedupe key, and done is `fulfilled_at`. Nothing here writes a status
 * that could disagree with any of the three, and a tick that dies halfway is picked up
 * by the next one.
 */

/** Filter first, then cap — a cap-then-filter would starve every family past the oldest
 * N forever. The ledger keeps this list short by construction. */
const MAX_CHECK_INS_PER_RUN = 100;

export interface PlanCheckInResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  due: number;
  sent: number;
  held: Record<ProactiveHoldReason, number>;
  /** Due, but nothing on the row could be turned into a message — an unknown topic, or
   * a recipient who no longer resolves. Named rather than counted as held: a hold is a
   * policy decision and this is a broken row. */
  unsendable: number;
  /** Due and allowed, but nothing sendable came back from the composer. The promise
   * stays open for the next tick — never a canned sentence in its place. */
  deferred: number;
  failed: number;
}

function emptyResult(enabled: boolean): PlanCheckInResult {
  return {
    enabled,
    due: 0,
    sent: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    unsendable: 0,
    deferred: 0,
    failed: 0,
  };
}

/** Who a check-in goes to, and where their thread is. */
export interface CheckInRecipient {
  parentUserId: string;
  /** The plan's own thread, so the follow-up lands in the conversation it belongs to
   * and the parent's answer reads as a reply to it. Null when the carrying message was
   * not threaded. */
  conversationId: string | null;
}

export interface PlanCheckInDeps {
  loadDue: typeof loadDueCommitments;
  /** The parent who was actually texted the plan, read back off the row that carried
   * it. Never a household lookup: a co-parent did not ask this question. */
  resolveRecipient(database: Database, channelMessageId: string): Promise<CheckInRecipient | null>;
  /** The one-line composer, shared with the age-gate refusal. */
  noteComposer: NoteComposer;
  /** The family's own clock — the day Hale promised is the day they live in. */
  loadTimeZone(database: Database, familyId: string): Promise<string>;
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive: typeof dedupeActive;
  resolveSendablePhone: typeof resolveSendablePhone;
  /** REQUIRED (rule #11). A sweep that can decide to follow up and quietly fail to is
   * the worst version of this: the promise closes, the family is audited as asked, and
   * nobody ever hears the question. */
  transport: ChannelTransport;
  recordSend(
    database: Database,
    write: {
      familyId: string;
      parentUserId: string;
      templateKey: string;
      dedupeKey: string;
      providerMessageId: string;
      relatedConversationId: string | null;
      sentAt: Date;
    },
  ): Promise<string>;
  audit(database: Database, row: Record<string, unknown>): Promise<void>;
  appendMessage: typeof appendMessage;
  fulfillCommitment: typeof fulfillCommitment;
}

export async function runPlanCheckInSweep(
  database: Database,
  deps: PlanCheckInDeps = defaultPlanCheckInDeps(),
  now: Date = new Date(),
): Promise<PlanCheckInResult> {
  const allFamilies = f14Enabled();
  const allowlist = f14Allowlist();
  // The same dark-launch gate the nudge sweep uses, deliberately, rather than a flag of
  // its own: this message only exists for a family already texting Hale and already
  // coached by it, so there is no world in which F14 is off and this should still fire.
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const due = (await deps.loadDue(database, 'plan_check_in', now, MAX_CHECK_INS_PER_RUN)).filter(
    (row) => allFamilies || allowlist.has(row.familyId),
  );
  result.due = due.length;

  for (const commitment of due) {
    try {
      await sendOne(database, deps, commitment, result, now);
    } catch (err) {
      result.failed += 1;
      // The commitment stays OPEN, so the next tick tries again. Never the body or the
      // question — the log carries ids and enums (rule #1).
      console.error(
        { err, commitmentId: commitment.id },
        'coach plan check-in: send failed - promise left open for the next tick',
      );
    }
  }
  return result;
}

async function sendOne(
  database: Database,
  deps: PlanCheckInDeps,
  commitment: DueCommitment,
  result: PlanCheckInResult,
  now: Date,
): Promise<void> {
  if (!isPlanTopic(commitment.topic)) {
    result.unsendable += 1;
    console.error(
      { commitmentId: commitment.id, topic: commitment.topic },
      'coach plan check-in: unknown topic, no reviewed sentence to send',
    );
    return;
  }
  const recipient = await deps.resolveRecipient(database, commitment.createdFrom);
  if (!recipient) {
    result.unsendable += 1;
    console.error(
      { commitmentId: commitment.id },
      'coach plan check-in: the message that carried the plan no longer resolves to a parent',
    );
    return;
  }

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: commitment.familyId,
      parentUserId: recipient.parentUserId,
      kind: 'plan_check_in',
      now,
    },
    deps.buildGate(database),
  );
  if (!verdict.allowed) {
    // Held, not failed, and the promise stays open: quiet hours end, and a family that
    // is over its budget this week is under it next week.
    result.held[verdict.reason] += 1;
    return;
  }

  const dedupeKey = `coach_plan:checkin:${commitment.id}`;
  if (await deps.dedupeActive(dedupeKey, database)) return;

  // Composed only AFTER the gate and the dedupe: a family who is over their budget or
  // already asked must not cost a model call.
  const timeZone = await deps.loadTimeZone(database, commitment.familyId);
  const composed = await deps.noteComposer.compose({
    kind: 'check_in',
    topic: commitment.topic,
    playbook: playbookFor(commitment.topic),
    child: null,
    question: null,
    promise: {
      summary: commitment.summary,
      // The day this row was DUE, named the way Hale named it in the plan.
      promisedDay: weekdayIn(commitment.dueAt, timeZone),
    },
  });
  if (composed.status === 'deferred') {
    // The promise stays open and the next tick tries again. Never a canned sentence.
    result.deferred += 1;
    console.error(
      { commitmentId: commitment.id, reason: composed.reason },
      'coach plan check-in: nothing sendable composed - promise left open for the next tick',
    );
    return;
  }

  const to = await deps.resolveSendablePhone(database, recipient.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`coach plan check-in: no send target for parent ${recipient.parentUserId}`);
  }

  const body = withOptOut(composed.message, verdict.optOut);
  const { providerMessageId } = await deps.transport.send({ to, body });
  const channelMessageId = await deps.recordSend(database, {
    familyId: commitment.familyId,
    parentUserId: recipient.parentUserId,
    templateKey: `coach_plan:check_in:${commitment.topic}`,
    dedupeKey,
    providerMessageId,
    relatedConversationId: recipient.conversationId,
    sentAt: now,
  });
  await deps.audit(database, {
    familyId: commitment.familyId,
    actor: 'system',
    actionTaken: 'coach_plan_check_in_sent',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
    after: { topic: commitment.topic },
  });
  // Threaded so the parent's answer arrives as an ordinary coach turn with the question
  // in front of it. That is the whole reason there is no handler for the reply: what
  // they say next is conversation, and the coach's memory tools can keep it.
  //
  // THE COMPOSED SENTENCE, NOT THE WIRE BODY. The CASL line belongs on the wire and
  // nowhere else: this thread is what the parent reads back in the app and what the coach
  // re-reads on their next turn, and a compliance footer in it is noise in both. It was
  // only ever visible on the first message of a period; now that the line rides every
  // proactive send (lib/channel/opt-out.ts), threading it would put one in the history
  // every time.
  if (recipient.conversationId) {
    await deps.appendMessage(recipient.conversationId, 'assistant', composed.message, database);
  }
  await deps.fulfillCommitment(database, {
    familyId: commitment.familyId,
    kind: 'plan_check_in',
    channelMessageId,
    now,
  });
  result.sent += 1;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The parent the plan's last message went to, and the thread it went to them in. */
export async function resolvePlanRecipient(
  database: Database,
  channelMessageId: string,
): Promise<CheckInRecipient | null> {
  const [row] = await database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      conversationId: schema.channelMessages.relatedConversationId,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, channelMessageId))
    .limit(1);
  if (!row?.parentUserId) return null;
  return { parentUserId: row.parentUserId, conversationId: row.conversationId ?? null };
}

export function defaultPlanCheckInDeps(): PlanCheckInDeps {
  return {
    loadDue: loadDueCommitments,
    resolveRecipient: resolvePlanRecipient,
    noteComposer: createNoteComposer(pipelineClient),
    loadTimeZone: (database, familyId) => readFamilyTimezone(database, familyId),
    buildGate: buildOutboundGatePorts,
    dedupeActive,
    resolveSendablePhone,
    transport: createTwilioTransport(),
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({
          familyId: write.familyId,
          parentUserId: write.parentUserId,
          channel: 'sms',
          direction: 'out',
          category: 'plan_check_in',
          templateKey: write.templateKey,
          dedupeKey: write.dedupeKey,
          providerMessageId: write.providerMessageId,
          status: 'sent',
          relatedConversationId: write.relatedConversationId,
          sentAt: write.sentAt,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('coach plan check-in: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    appendMessage,
    fulfillCommitment,
  };
}
