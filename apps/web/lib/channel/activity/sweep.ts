import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { f14Allowlist, f14Enabled } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { appendMessage } from '~/lib/coach/conversation';
import { type DueCommitment, fulfillCommitment, loadDueCommitments } from '~/lib/commitments/ledger';
import { pipelineClient } from '~/lib/pipeline/client';
import { cancelActivityPromise } from './commitment';
import { deidentifyActivityQuery } from './deidentify';
import { type FollowUpComposer, createFollowUpComposer } from './followup-note';
import { type ActivityFinder, createActivityFinder } from './lane';
import { type ActivityFamilyReader, productionActivityFamilyReader } from './reader';

/**
 * THE SWEEP THAT KEEPS THE PROMISE.
 *
 * Every "I'll come back to you" the coach says is a row on the open-loops ledger
 * (commitment.ts). This is the thing that makes that row mean something: within the day,
 * every open promise gets an answer — the finds, or an honest account of not finding them.
 *
 * NOT FINDING IS AN OUTCOME THE PARENT HEARS, and that is the load-bearing part. A sweep
 * that texted only when the search succeeded would silently drop every disappointing
 * promise, which is a worse version of the defect this whole arc exists to fix: the parent
 * would be left waiting for something Hale had quietly decided not to send. So a
 * `no_picks` search composes and sends the empty-handed message and CLOSES the promise as
 * kept — because the promise was to come back, not to succeed (rule #11).
 *
 * WHAT LEAVES IT OPEN, deliberately: a hold (quiet hours, a family over budget), a
 * composer that could not produce a sendable sentence, and a thrown send. All three come
 * back on the next tick. What CLOSES it without a message is exactly one thing: a family
 * that no longer has a sendable channel, which is cancelled with a reason — a debt nothing
 * can ever discharge must not sit in the ledger forever reading as one Hale is ignoring.
 *
 * IT RIDES THE HOURLY NUDGE CRON, the way the plan check-in and the village intros do, and
 * for their reasons: that cron already exists to decide whether to interrupt a parent, it
 * already runs at the cadence this needs, and a second Vercel slot would be a second
 * failure budget and a second place to forget the dark-launch flag.
 *
 * THE LEDGER IS THE STATE MACHINE. Due is a query (`due_at <= now` on an open row),
 * sent-once is the dedupe key, and kept is `fulfilled_at`. Nothing here writes a status
 * that could disagree with any of the three, and a tick that dies halfway is picked up by
 * the next one.
 */

/** Filter first, then cap — a cap-then-filter would starve every family past the oldest N
 * forever. The ledger keeps this list short by construction (one open promise per family). */
const MAX_FOLLOWUPS_PER_RUN = 100;

export interface ActivityFollowUpResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  due: number;
  sent: number;
  /** Sent, and the honest empty-handed half — counted separately because a run that is
   * all bad news is a signal about the lane, not about the sweep. */
  sentEmptyHanded: number;
  held: Record<ProactiveHoldReason, number>;
  /** Due, but nothing on the row could be turned into a search — an empty subject, or a
   * recipient who no longer resolves. Named rather than counted as held: a hold is a
   * policy decision and this is a broken row. */
  unsendable: number;
  /** Promises voided because the family can no longer be texted at all. */
  cancelled: number;
  /** Due and allowed, but nothing sendable came back from the composer. The promise stays
   * open for the next tick — never a canned sentence in its place. */
  deferred: number;
  failed: number;
}

function emptyResult(enabled: boolean): ActivityFollowUpResult {
  return {
    enabled,
    due: 0,
    sent: 0,
    sentEmptyHanded: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    unsendable: 0,
    cancelled: 0,
    deferred: 0,
    failed: 0,
  };
}

/** Who the promise is owed to, and the thread it was made in. */
export interface FollowUpRecipient {
  parentUserId: string;
  /** The conversation the promise was made in, so the answer lands where the question was
   * asked. Null when the carrying message was not threaded. */
  conversationId: string | null;
}

export interface ActivityFollowUpDeps {
  loadDue: typeof loadDueCommitments;
  /** The parent who was actually texted the promise, read back off the row that carried
   * it. Never a household lookup: a co-parent did not ask this question. */
  resolveRecipient(database: Database, channelMessageId: string): Promise<FollowUpRecipient | null>;
  reader: ActivityFamilyReader;
  /** REQUIRED (rule #11). The whole point of the sweep is that the search actually runs. */
  finder: ActivityFinder;
  composer: FollowUpComposer;
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive: typeof dedupeActive;
  resolveSendablePhone: typeof resolveSendablePhone;
  /** REQUIRED (rule #11). A sweep that can decide to keep a promise and quietly fail to
   * send is the worst version of this: the debt closes, the ledger reads as paid, and
   * nobody ever hears back. */
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
  cancelPromise: typeof cancelActivityPromise;
}

export async function runActivityFollowUpSweep(
  database: Database,
  deps: ActivityFollowUpDeps = defaultActivityFollowUpDeps(),
  now: Date = new Date(),
): Promise<ActivityFollowUpResult> {
  const allFamilies = f14Enabled();
  const allowlist = f14Allowlist();
  // The same dark-launch gate the other coach sweeps use, and for the same reason: this
  // message only exists for a family already texting Hale, so there is no world in which
  // F14 is off and this should still fire.
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const due = (
    await deps.loadDue(database, 'activity_followup', now, MAX_FOLLOWUPS_PER_RUN)
  ).filter((row) => allFamilies || allowlist.has(row.familyId));
  result.due = due.length;

  for (const commitment of due) {
    try {
      await keepOne(database, deps, commitment, result, now);
    } catch (err) {
      result.failed += 1;
      // The promise stays OPEN, so the next tick tries again. Never the subject or the
      // body — the log carries ids and enums (rule #1).
      console.error(
        { err, commitmentId: commitment.id },
        'activity follow-up: send failed - promise left open for the next tick',
      );
    }
  }
  return result;
}

async function keepOne(
  database: Database,
  deps: ActivityFollowUpDeps,
  commitment: DueCommitment,
  result: ActivityFollowUpResult,
  now: Date,
): Promise<void> {
  const subject = commitment.topic?.trim() ?? '';
  if (subject === '') {
    result.unsendable += 1;
    console.error(
      { commitmentId: commitment.id },
      'activity follow-up: the promise names no subject, nothing to search',
    );
    return;
  }
  const recipient = await deps.resolveRecipient(database, commitment.createdFrom);
  if (!recipient) {
    result.unsendable += 1;
    console.error(
      { commitmentId: commitment.id },
      'activity follow-up: the message that carried the promise no longer resolves to a parent',
    );
    return;
  }

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: commitment.familyId,
      parentUserId: recipient.parentUserId,
      kind: 'activity_followup',
      now,
    },
    deps.buildGate(database),
  );
  if (!verdict.allowed) {
    // A family with no live channel can never be come back to, so the promise is VOIDED
    // with a reason rather than left to sit open forever reading as a debt Hale is
    // ignoring. Every other hold is temporary — quiet hours end, a week rolls over — so
    // those leave it open for the next tick.
    if (verdict.reason === 'not_enrolled') {
      await deps.cancelPromise(database, { familyId: commitment.familyId, now });
      result.cancelled += 1;
      return;
    }
    result.held[verdict.reason] += 1;
    return;
  }

  const dedupeKey = `activity_followup:${commitment.id}`;
  if (await deps.dedupeActive(dedupeKey, database)) return;

  // Searched only AFTER the gate and the dedupe: a family who is over their budget or has
  // already been answered must not cost a web search (the per-search provider bill is the
  // reason this ordering is not merely tidy).
  const [municipality, stage, householdNames] = await Promise.all([
    deps.reader.municipality(database, commitment.familyId),
    deps.reader.stage(database, commitment.familyId, commitment.subjectChildId),
    deps.reader.householdNames(database, commitment.familyId),
  ]);
  // Phase 0 AGAIN, a day later. The subject cleared it when the promise was made, but the
  // household can have changed since — a child added this morning is a name that must not
  // cross the border this afternoon (rule #1). A subject that no longer clears is not
  // searched and the promise stays open for a human to see in the overdue count.
  const deidentified = deidentifyActivityQuery({
    subject,
    municipality,
    stage,
    householdNames,
  });
  if (!deidentified.ok) {
    result.unsendable += 1;
    console.error(
      { commitmentId: commitment.id, refusal: deidentified.refusal },
      'activity follow-up: the stored subject no longer clears de-identification',
    );
    return;
  }

  const found = await deps.finder.find(deidentified.query);
  if (!found.found && found.reason !== 'no_picks') {
    // The search itself could not run. That is not news, it is an outage — so nothing is
    // sent and the promise stays open for the next tick, which is exactly the difference
    // between "there is nothing on" and "I could not look".
    result.deferred += 1;
    console.error(
      { commitmentId: commitment.id, reason: found.reason },
      'activity follow-up: the search could not run - promise left open for the next tick',
    );
    return;
  }
  const picks = found.found ? found.picks : [];

  const composed = await deps.composer.compose({ subject, picks });
  if (composed.status === 'deferred') {
    result.deferred += 1;
    console.error(
      { commitmentId: commitment.id, reason: composed.reason },
      'activity follow-up: nothing sendable composed - promise left open for the next tick',
    );
    return;
  }

  const to = await deps.resolveSendablePhone(database, recipient.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`activity follow-up: no send target for parent ${recipient.parentUserId}`);
  }

  const body = withOptOut(composed.message, verdict.optOut);
  const { providerMessageId } = await deps.transport.send({ to, body });
  const channelMessageId = await deps.recordSend(database, {
    familyId: commitment.familyId,
    parentUserId: recipient.parentUserId,
    templateKey: 'activity_followup:kept',
    dedupeKey,
    providerMessageId,
    relatedConversationId: recipient.conversationId,
    sentAt: now,
  });
  await deps.audit(database, {
    familyId: commitment.familyId,
    actor: 'system',
    actionTaken: 'activity_followup_sent',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
    // A COUNT, never the finds themselves: an audit row is read by ops and by a
    // right-to-access export, and neither needs the venue names (rule #1).
    after: { picks: picks.length },
  });
  // Threaded so the parent's answer arrives as an ordinary coach turn with the finds in
  // front of it. The COMPOSED sentence, not the wire body: the CASL line belongs on the
  // wire and nowhere else (plan check-in keeps the same rule, for the same reason).
  if (recipient.conversationId) {
    await deps.appendMessage(recipient.conversationId, 'assistant', composed.message, database);
  }
  // KEPT, against the message that kept it — including when the message was bad news. The
  // promise was to come back.
  await deps.fulfillCommitment(database, {
    familyId: commitment.familyId,
    kind: 'activity_followup',
    channelMessageId,
    now,
  });
  result.sent += 1;
  if (picks.length === 0) result.sentEmptyHanded += 1;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The parent the promise went to, and the thread it went to them in. */
export async function resolveFollowUpRecipient(
  database: Database,
  channelMessageId: string,
): Promise<FollowUpRecipient | null> {
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

export function defaultActivityFollowUpDeps(): ActivityFollowUpDeps {
  return {
    loadDue: loadDueCommitments,
    resolveRecipient: resolveFollowUpRecipient,
    reader: productionActivityFamilyReader(),
    finder: createActivityFinder(pipelineClient),
    composer: createFollowUpComposer(pipelineClient),
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
          category: 'activity_followup',
          templateKey: write.templateKey,
          dedupeKey: write.dedupeKey,
          providerMessageId: write.providerMessageId,
          status: acceptedStatus('sms'),
          relatedConversationId: write.relatedConversationId,
          sentAt: write.sentAt,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('activity follow-up: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    appendMessage,
    fulfillCommitment,
    cancelPromise: cancelActivityPromise,
  };
}
