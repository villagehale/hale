import type { Database } from '@hale/db';
import type { DeepResearchPayload } from '@hale/tools-contracts';
import { captureAgentError } from '~/lib/analytics/server-capture';
import { f14Allowlist, f14Enabled } from '~/lib/channel/f14';
import { dedupeActive } from '~/lib/channel/ledger';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type DueCommitment, loadOpenCommitmentById } from '~/lib/commitments/ledger';
import { type DeepLaneDeps, type DeepLaneRun, defaultDeepLaneDeps, runDeepLane } from './deep-lane';
import { deidentifyActivityQuery } from './deidentify';
import { type FollowUpDelivery, deliverFollowUp } from './deliver';
import { type ActivityFamilyReader, productionActivityFamilyReader } from './reader';
import { SLOTS_IN_TEXT } from './share-page';
import { cancelActivityPromise } from './commitment';
import { defaultActivityFollowUpDeps, resolveFollowUpRecipient } from './sweep';

/**
 * THE SECOND MESSAGE — a promise kept in minutes instead of in a day.
 *
 * WHAT THIS CHANGES FOR A PARENT. They text at 19:40 asking about a named gym. At 19:40
 * they get an answer built from what a search engine chose to show a thirty-second turn,
 * ending in a sentence that says Hale will go and look properly. At 19:44 they get the
 * day, the fee and the date registration opened, off pages somebody opened, each fact
 * checked against the page it came from. Two messages, one question, and the second one
 * arrives while they are still thinking about the first.
 *
 * IT IS THE SAME PROMISE, KEPT EARLY. Nothing here mints anything: the row was written by
 * the router at send time against the message that carried it (#532's reconciliation), and
 * this job carries only its id. Keeping it early is the whole of the change — the ledger,
 * the dedupe key, the gates, the composer, the threading and the fulfilment are the
 * hourly sweep's, verbatim, because they are shared code (deliver.ts).
 *
 * WHAT IT REFUSES TO DO, and this is the part that makes two messages honest rather than
 * noisy:
 *
 *   NO PAGES OPENED, NO SECOND MESSAGE. The fan-out failing or opening nothing leaves the
 *   promise OPEN and sends NOTHING. There is no shallow fallback here, deliberately —
 *   unlike the sweep, which is a parent's last chance at an answer and rightly falls back
 *   to snippets. A second text built from the same snippets the inline turn already read
 *   is Hale repeating itself for money, and the promise is still owed, so the sweep will
 *   keep it within the day (rule #11).
 *
 *   NOTHING SURVIVED THE REFUTATION, NO SECOND MESSAGE. Same reasoning one layer down: the
 *   pages opened, the merge proposed rows, and every row was uncited or unquoted. That is
 *   an empty-handed DEEP pass, and the honest thing is to leave the promise for an
 *   instrument that might do better rather than to send "I looked and found nothing" about
 *   a lane whose own gate threw the answer away.
 *
 *   HELD IS NOT FAILED. Quiet hours at 22:10 hold the send, and the promise waits for the
 *   sweep at 08:00 — the outbound chokepoint's floor is not something this lane's speed
 *   buys its way past.
 */

export type DeepJobOutcome =
  /** Sent. The parent has both messages. */
  | { status: 'sent'; watch: boolean; shared: boolean }
  /** The promise is no longer open — fulfilled by the sweep, superseded, or this job
   * redelivered after its own send. Nothing owed, nothing sent. */
  | { status: 'dropped'; reason: 'not_open' | 'dark' | 'already_sent' }
  /** The outbound chokepoint said no. The promise stays open. */
  | { status: 'held'; reason: ProactiveHoldReason }
  /** The family can no longer be texted at all; the promise is voided with a reason. */
  | { status: 'cancelled' }
  /**
   * Nothing was sent and the promise STAYS OPEN for the hourly sweep. The reason names
   * which half fell over, because they need different fixes: `deep_unavailable` is the
   * research or the merge failing, `deep_unread` is every fetch refused, `all_refuted` is
   * the adversarial pass leaving nothing, and the last two are the composer and the send
   * gates — the same two outcomes the sweep counts under those names.
   */
  | {
      status: 'left_open';
      reason:
        | 'unsendable'
        | 'deep_unavailable'
        | 'deep_unread'
        | 'all_refuted'
        | 'deferred'
        | 'refused_at_send';
    };

export interface DeepJobDeps {
  loadOpen(database: Database, id: string): Promise<DueCommitment | null>;
  resolveRecipient: typeof resolveFollowUpRecipient;
  reader: ActivityFamilyReader;
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive: typeof dedupeActive;
  /** REQUIRED (rule #11). The lane is the entire reason this job exists — a job that
   * could be wired without it would send the inline turn's own answer back. */
  lane: DeepLaneDeps;
  /** The nine steps between picks and a phone, shared with the sweep. */
  delivery: FollowUpDelivery;
  cancelPromise: typeof cancelActivityPromise;
}

/**
 * Run the deep pass for one promise.
 *
 * A THROW MEANS REDELIVERY, and every branch that is a real outcome returns instead. The
 * one thing that throws is a contradiction — the gate saying a parent has a live channel
 * and then no number resolving — because that is a bug rather than a state.
 */
export async function runDeepResearchJob(
  database: Database,
  payload: DeepResearchPayload,
  deps: DeepJobDeps = defaultDeepJobDeps(),
  now: Date = new Date(),
): Promise<DeepJobOutcome> {
  // The same dark-launch gate every other coach surface reads. A job enqueued while the
  // flag was on and drained after it went off must not text anybody.
  if (!f14Enabled() && !f14Allowlist().has(payload.family_id)) {
    return { status: 'dropped', reason: 'dark' };
  }

  const commitment = await deps.loadOpen(database, payload.commitment_id);
  if (!commitment) {
    // Fulfilled, superseded, or this job came back round after its own send. All three
    // mean the same thing to a parent: they have their answer.
    return { status: 'dropped', reason: 'not_open' };
  }

  const subject = commitment.topic?.trim() ?? '';
  if (subject === '') {
    console.error(
      { commitmentId: commitment.id },
      'activity deep job: the promise names no subject, nothing to research',
    );
    return { status: 'left_open', reason: 'unsendable' };
  }

  const recipient = await deps.resolveRecipient(database, commitment.createdFrom);
  if (!recipient) {
    console.error(
      { commitmentId: commitment.id },
      'activity deep job: the message that carried the promise no longer resolves to a parent',
    );
    return { status: 'left_open', reason: 'unsendable' };
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
    // with a reason rather than left to sit open forever. Every other hold is temporary,
    // and the hourly sweep is what tries again — the same split the sweep itself makes.
    if (verdict.reason === 'not_enrolled') {
      await deps.cancelPromise(database, { familyId: commitment.familyId, now });
      return { status: 'cancelled' };
    }
    return { status: 'held', reason: verdict.reason };
  }

  // THE SAME KEY THE SWEEP WOULD USE. Two things can now answer one promise, and this is
  // what stops both doing it: whichever gets there first claims the key, and the other
  // finds it taken.
  const dedupeKey = `activity_followup:${commitment.id}`;
  if (await deps.dedupeActive(dedupeKey, database)) {
    return { status: 'dropped', reason: 'already_sent' };
  }

  const [municipality, stage, householdNames] = await Promise.all([
    deps.reader.municipality(database, commitment.familyId),
    deps.reader.stage(database, commitment.familyId, commitment.subjectChildId),
    deps.reader.householdNames(database, commitment.familyId),
  ]);
  // PHASE 0 AGAIN, minutes later. The subject cleared it when the promise was made, but
  // the household can have changed since — a child added this morning is a name that must
  // not cross the border this afternoon (rule #1).
  const deidentified = deidentifyActivityQuery({ subject, municipality, stage, householdNames });
  if (!deidentified.ok) {
    console.error(
      { commitmentId: commitment.id, refusal: deidentified.refusal },
      'activity deep job: the stored subject no longer clears de-identification',
    );
    return { status: 'left_open', reason: 'unsendable' };
  }

  const run: DeepLaneRun = await runDeepLane(deps.lane, deidentified.query);
  if (run.result.status !== 'read') {
    // Counted as a RATE and not only logged: this job is the product's most expensive
    // instrument and it runs where nobody is watching, so "it stopped working" has to be
    // a number. Only the enum and a hashed family id travel.
    await captureAgentError({
      lane: 'commitments',
      kind: `activity_deep_${run.result.status === 'unread' ? 'unread' : run.result.reason}`,
      familyId: commitment.familyId,
    });
    console.error(
      { commitmentId: commitment.id, ...run.evidence },
      'activity deep job: nothing was read - promise left open for the hourly sweep',
    );
    return {
      status: 'left_open',
      reason: run.result.status === 'unread' ? 'deep_unread' : 'deep_unavailable',
    };
  }

  if (run.result.slots.length === 0) {
    // The pages opened and the adversarial pass left nothing standing. See the module
    // note: this is not an empty-handed search, it is a deep pass whose own gate threw the
    // answer away, and the two must not produce the same text.
    console.error(
      { commitmentId: commitment.id, ...run.evidence },
      'activity deep job: every row was refuted - promise left open for the hourly sweep',
    );
    return { status: 'left_open', reason: 'all_refuted' };
  }

  const outcome = await deliverFollowUp(
    database,
    deps.delivery,
    {
      commitmentId: commitment.id,
      familyId: commitment.familyId,
      subjectChildId: commitment.subjectChildId,
      subject,
      recipient,
      dedupeKey,
      optOut: verdict.optOut,
      // The text carries the best one or two; everything else goes on a page. Slicing
      // HERE rather than asking the model for a shortlist is what makes "and the rest is
      // at this link" true — the remainder is a real list, not a claim.
      picks: run.result.slots.slice(0, SLOTS_IN_TEXT),
      rest: run.result.slots,
      // A PAGE, TODAY. Not a snippet, and not a `web_fetch` the provider answered out of
      // a cache from before today (evidence.ts `pagesStale`).
      pagesOpened: run.result.pagesRead - run.result.pagesStale > 0,
      evidence: run.evidence,
    },
    now,
  );
  if (outcome.status === 'deferred') return { status: 'left_open', reason: 'deferred' };
  if (outcome.status === 'refused_at_send') {
    return { status: 'left_open', reason: 'refused_at_send' };
  }
  return { status: 'sent', watch: outcome.watch, shared: outcome.shared };
}

/**
 * The production wiring.
 *
 * The DELIVERY is the sweep's own dependency object, not a second copy of it: whatever
 * the hourly sweep sends with, this sends with. That is the invariant the shared module
 * exists for, and building it here from `defaultActivityFollowUpDeps` is what keeps it
 * true when somebody changes the sweep's transport and forgets this file.
 */
export function defaultDeepJobDeps(): DeepJobDeps {
  const sweep = defaultActivityFollowUpDeps();
  return {
    loadOpen: loadOpenCommitmentById,
    resolveRecipient: resolveFollowUpRecipient,
    reader: productionActivityFamilyReader(),
    buildGate: buildOutboundGatePorts,
    dedupeActive,
    lane: defaultDeepLaneDeps(),
    delivery: sweep,
    cancelPromise: cancelActivityPromise,
  };
}

/** The drain's handler: keep one promise, now. */
export async function keepPromiseNow(
  database: Database,
  payload: DeepResearchPayload,
): Promise<DeepJobOutcome> {
  return runDeepResearchJob(database, payload);
}
