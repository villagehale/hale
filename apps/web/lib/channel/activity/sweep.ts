import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { captureAgentError } from '~/lib/analytics/server-capture';
import { f14Allowlist, f14Enabled } from '~/lib/channel/f14';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { refuseUnbackedSend } from '~/lib/channel/reconcile/gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import {
  type DueCommitment,
  fulfillCommitment,
  loadDueCommitments,
} from '~/lib/commitments/ledger';
import { activityClient, pipelineClient } from '~/lib/pipeline/client';
import {
  cancelActivityPromise,
  defaultActivityPromisePorts,
  recordActivityPromise,
} from './commitment';
import { type DeepResearcher, type DeepSlot, createDeepResearcher } from './deep';
import { deidentifyActivityQuery } from './deidentify';
import {
  type FollowUpDelivery,
  type FollowUpRecipient,
  deliverFollowUp,
  noEvidence,
} from './deliver';
import { type FollowUpPick, createFollowUpComposer } from './followup-note';
import { type ActivityFinder, createActivityFinder } from './lane';
import { type ActivityFamilyReader, productionActivityFamilyReader } from './reader';
import { SLOTS_IN_TEXT, defaultActivitySharePorts, mintActivitySharePage } from './share-page';

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

/**
 * How many promises get the DEEP pass in one tick.
 *
 * ONE, and the number is the cron slot rather than a preference. It was TWO while the
 * research turn was assumed to run "between 50 and 130 seconds" — an estimate taken from
 * a leg that, as it turned out, never completed at all: every production deep pass was
 * timing out at 50s and falling back to the shallow search (see deep.ts on why it is
 * streamed now). Measured properly, streamed, on the real API 2026-08-22: 88.8s of
 * research plus ~13s of extract, so one pass is ~100 seconds of a 300-second Vercel
 * function (api/cron/nudge, `maxDuration = 300`) that this sweep enters LAST, behind the
 * nudge, the intros, the follow-up asks and the plan check-in. Two would be a sweep that
 * reliably dies halfway.
 *
 * It is not a cap on FOLLOW-UPS — every due promise is still kept this tick. It is a cap
 * on the expensive instrument: past the first, a promise falls back to the shallow
 * search, which is a worse answer and still an answer. And the ledger's
 * one-open-promise-per-family index keeps the queue short enough that "past the first"
 * is rare.
 */
const MAX_DEEP_PER_RUN = 1;

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
  /**
   * Composed, gated, appended to — and the body that came out the other end still asked
   * the parent something, so it was refused at the send boundary.
   *
   * Its own count and not folded into `deferred`, because the two mean opposite things
   * about where the fault is: `deferred` is the model failing to write a sendable
   * sentence, and this is CODE having put a question into a sentence the gates had
   * already passed. A run with a non-zero here has a bug in the append path, and that
   * must not be readable as the composer having a bad day (rule #11).
   */
  refusedAtSend: number;
  failed: number;
  /** How many promises the deep pass actually researched — pages opened, not snippets
   * read. Counted because the difference between this and `sent` is the difference
   * between the sweep this product promises and the one it used to be. */
  deepRead: number;
  /** Deep passes that reached the web and could not open a single page (every fetch
   * refused or unreachable). Named, not folded into a failure: the run happened, it just
   * knows nothing about what those pages carry (rule #11). */
  deepUnread: number;
  /**
   * Deep passes that never ran — no client, no skill, an ungrounded turn, a research or
   * extract leg that threw.
   *
   * COUNTED, and it was not. `unavailable` incremented neither `deepRead` nor
   * `deepUnread`, so a leg that was failing on EVERY tick — which is exactly what the
   * un-streamed research turn was doing (deep.ts) — showed up in this result as a run
   * where the deep pass simply had not been reached. The differentiator was dead for a
   * day and the only number that would have said so did not exist (rule #11).
   */
  deepUnavailable: number;
  /**
   * Follow-ups that left something open and REGISTERED the continuation promise for it —
   * the row behind "I'll keep watching and text you when they post".
   */
  watching: number;
  /**
   * Follow-ups whose message says Hale is still watching and whose row did not get
   * written. The worst outcome this sweep has, so it is a count and not a log line: the
   * parent has been told Hale is on it and nothing in the system knows.
   */
  watchUnrecorded: number;
  /** Follow-ups that carried a link to the rest of the schedule. */
  shared: number;
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
    refusedAtSend: 0,
    failed: 0,
    deepRead: 0,
    deepUnread: 0,
    deepUnavailable: 0,
    watching: 0,
    watchUnrecorded: 0,
    shared: 0,
  };
}

/**
 * WHAT THE SWEEP NEEDS, on top of what a delivery needs.
 *
 * It EXTENDS {@link FollowUpDelivery} rather than restating it: the nine effects between
 * a set of picks and a parent's phone belong to the delivery, both callers hand over the
 * same object, and a second declaration of them is the seam a second implementation grows
 * out of. What is left here is what makes this the SWEEP — the due query, the recipient
 * read, the two researchers, the outbound gate and the cancellation.
 */
export interface ActivityFollowUpDeps extends FollowUpDelivery {
  loadDue: typeof loadDueCommitments;
  /** The parent who was actually texted the promise, read back off the row that carried
   * it. Never a household lookup: a co-parent did not ask this question. */
  resolveRecipient(database: Database, channelMessageId: string): Promise<FollowUpRecipient | null>;
  reader: ActivityFamilyReader;
  /** REQUIRED (rule #11). The whole point of the sweep is that the search actually runs. */
  finder: ActivityFinder;
  /**
   * THE DIFFERENTIATOR, and required for the same reason the finder is. Without it this
   * sweep is a re-run of the same snippet search a day later, which is what it was and
   * what produced the benchmark defect. A sweep that could be wired with the deep pass
   * absent is a sweep that can silently be the old one.
   */
  deep: DeepResearcher;
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive: typeof dedupeActive;
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
      // A promise Hale made and did not keep is the failure this whole sweep exists to
      // prevent, and it retries silently — so the same row can fail every tick for a day
      // with nothing but log lines to show for it. Counted per household and per kind of
      // promise; the topic (which is the parent's own words) never travels.
      await captureAgentError({
        lane: 'commitments',
        kind: 'activity_followup',
        familyId: commitment.familyId,
      });
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

  // THE DEEP PASS FIRST. This is where the sweep stopped being a re-run of the inline
  // search: the researcher runs site-scoped searches into the operator's own domain, opens
  // the pages those surface, and comes back with dated slots that each cite the page they
  // were read off. What it hands back is a richer ActivityPick, so the composer below is
  // unchanged — it just has something worth writing about.
  // A FOLLOW-UP PICK, not an `ActivityPick`. The deep pass returns slots carrying the
  // registration fact, and the wider type is what lets the composer be handed it: widening
  // them to `ActivityPick` here compiled fine, kept the field at runtime, and made it
  // invisible to every reader downstream — which is exactly how it got dropped.
  let picks: FollowUpPick[] = [];
  let rest: readonly DeepSlot[] = [];
  let researched = false;
  const evidence = noEvidence();
  // A PAGE, TODAY, and nothing else licenses a sentence about what a page does not carry.
  // Not a snippet, and not a `web_fetch` the provider answered out of a cache from before
  // today (deep.ts `pagesStale`).
  let pagesOpened = false;
  if (result.deepRead + result.deepUnread + result.deepUnavailable < MAX_DEEP_PER_RUN) {
    const deep = await deps.deep.research(deidentified.query);
    if (deep.status === 'read') {
      result.deepRead += 1;
      researched = true;
      evidence.deepRead = 1;
      evidence.searchResults = deep.searchResults;
      evidence.pagesRead = deep.pagesRead;
      evidence.pagesRefused = deep.pagesRefused;
      pagesOpened = deep.pagesRead - deep.pagesStale > 0;
      // The text carries the best one or two; everything else goes on a page. Slicing
      // HERE rather than asking the model for a shortlist is what makes "and the rest is
      // at this link" true — the remainder is a real list, not a claim.
      picks = deep.slots.slice(0, SLOTS_IN_TEXT);
      rest = deep.slots;
    } else if (deep.status === 'unread') {
      // It reached the web and could not open one page — every fetch refused or
      // unreachable, which the live probe showed is a real and common shape. It knows
      // nothing about what those pages carry, so it must not compose a message that says
      // they carry nothing. The shallow search below still runs, and its snippets still
      // hold real finds; what is lost is the dated detail, not the answer.
      result.deepUnread += 1;
      evidence.deepUnread = 1;
      evidence.searchResults = deep.searchResults;
      evidence.pagesRefused = deep.pagesRefused;
      console.error(
        { commitmentId: commitment.id, pagesRefused: deep.pagesRefused },
        'activity follow-up: deep pass opened no page - falling back to the shallow search',
      );
    } else {
      // The leg never ran. Counted rather than passed over in silence: this is the
      // branch a timing-out research turn spent every tick of 2026-08-22 in, and it was
      // the only one of the three with no number attached (rule #11).
      result.deepUnavailable += 1;
      console.error(
        { commitmentId: commitment.id, reason: deep.reason },
        'activity follow-up: deep pass unavailable - falling back to the shallow search',
      );
    }
  }

  if (!researched) {
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
    picks = found.found ? [...found.picks] : [];
  }
  evidence.picks = picks.length;

  // THE SEND HALF, shared verbatim with the question-time deep job (deliver.ts). Nine
  // steps in a fixed order, seven of them added because one had gone wrong in production
  // — and exactly one copy of them, so the two callers cannot drift.
  const outcome = await deliverFollowUp(
    database,
    deps,
    {
      commitmentId: commitment.id,
      familyId: commitment.familyId,
      subjectChildId: commitment.subjectChildId,
      subject,
      recipient,
      dedupeKey,
      optOut: verdict.optOut,
      picks,
      rest,
      pagesOpened,
      evidence,
    },
    now,
  );
  if (outcome.status === 'deferred') {
    result.deferred += 1;
    return;
  }
  if (outcome.status === 'refused_at_send') {
    result.refusedAtSend += 1;
    return;
  }
  result.sent += 1;
  if (outcome.emptyHanded) result.sentEmptyHanded += 1;
  if (outcome.shared) result.shared += 1;
  if (outcome.watchRecorded === true) result.watching += 1;
  if (outcome.watchRecorded === false) result.watchUnrecorded += 1;
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
    // The deep researcher rides the ACTIVITY client, not the pipeline one: it opens pages
    // and a live probe put one research turn between 50 and 130 seconds, which is well
    // past the pipeline client's patience (see ACTIVITY_CLIENT_OPTIONS).
    deep: createDeepResearcher(activityClient),
    composer: createFollowUpComposer(pipelineClient),
    sharePage: (database, input) =>
      mintActivitySharePage(database, input, defaultActivitySharePorts()),
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
    threadMessage: threadProactiveMessage,
    fulfillCommitment,
    cancelPromise: cancelActivityPromise,
    refuseUnbackedSend,
    recordWatch: (database, input) =>
      recordActivityPromise(database, input, defaultActivityPromisePorts()),
  };
}
