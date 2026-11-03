import type { Database } from '@hale/db';
import { extractStateClaims } from './claims';
import { type ReconcileVerdict, reconcile } from './reconcile';
import { loadReconcileView } from './view';

/**
 * VIL-293 · THE SEND-BOUNDARY GATE for a lane that cannot re-ask.
 *
 * The coach can be told what it got wrong and asked again, because a parent is waiting
 * and silence is the worse failure (route.ts). A SWEEP cannot: there is nobody waiting,
 * the message is composed from a template or from a composer with its own grounding
 * gates, and the right answer to an unbacked sentence is to send nothing and let the
 * next tick try. That is #529's `refusedAtSend`, generalised.
 *
 * A MINT IS ALSO A REFUSAL HERE, and that is the one thing that differs from the coach's
 * reading of the same verdict. `minted` means "no row yet, but the facts allow one" — and
 * allowing one is only useful to a caller that will go on to WRITE it against the message
 * it is about to send. A sweep that sent the promise and wrote nothing would be the exact
 * defect this primitive exists to close, so a lane that cannot mint treats a mintable
 * promise as unsendable and says so under its own name.
 *
 * IT RUNS LAST, on the string that actually leaves. Everything between a gate and the
 * transport is unchecked by construction — the 2026-08-22 lesson from an append running
 * past a green gate (activity/deliver.ts).
 */

/** Why the wire body was refused. The reconcile's own reasons, plus the one this gate
 * adds for a promise a sweep would have had to write and cannot. */
export type SendRefusalReason =
  | ReconcileVerdict['refused'][number]['reason']
  | 'unrecorded_promise';

/** Every reason this body may not go out, in the order the claims appear. Empty means
 * send it. */
export function unsendableReasons(verdict: ReconcileVerdict): SendRefusalReason[] {
  return [
    ...verdict.refused.map((resolution) => resolution.reason),
    ...verdict.mints.map(() => 'unrecorded_promise' as const),
  ];
}

/**
 * Read the family's ledger and judge the body against it — the whole primitive, for a
 * caller that has a database handle and one string to decide about.
 */
export async function refuseUnbackedSend(
  database: Database,
  input: {
    familyId: string;
    body: string;
    now: Date;
    /** The activity composer validated a continuation that this send will record. */
    activityFollowUp?: boolean;
  },
): Promise<SendRefusalReason[]> {
  const claims = extractStateClaims(input.body);
  // NO CLAIM, NO QUERY. The overwhelming majority of bodies assert nothing this
  // primitive owns, and those must not cost a sweep four selects per message.
  if (claims.length === 0) return [];
  const view = await loadReconcileView(database, { familyId: input.familyId, now: input.now });
  const activityFollowUp = input.activityFollowUp && view.openKinds.has('activity_followup');
  // Keep the named registration object for a later "I'll remind you" in this message.
  const contextualClaims =
    activityFollowUp && claims.some((claim) => claim.kind === 'registration_watch')
      ? extractStateClaims(input.body, true)
      : claims;
  // A factual registration preamble must not change the kind of an activity continuation.
  const remaining = activityFollowUp
    ? contextualClaims.flatMap((claim) => {
        if (claim.kind === 'activity_followup') return [];
        if (claim.kind !== 'registration_watch') return [claim];
        const promise = claim.sentence.search(
          /\bi(?:'ll|\s+will|'m\s+\w+ing|\s+am\s+going\s+to)\b/i,
        );
        if (promise < 0) return [claim];
        const continuation = claim.sentence.slice(promise);
        // Booking claims remain in contextualClaims and always get their own row check.
        const scoped = extractStateClaims(continuation, true).filter(
          (claim) => claim.kind !== 'scheduled_event',
        );
        const publicationCheck =
          /\bkeep\s+watching\b/i.test(continuation) &&
          /\b(?:when|once|as soon as)\b[^.!?]*\b(?:post(?:s|ed|ing)?|publish(?:es|ed|ing)?)\b/i.test(
            continuation,
          );
        // An unrecognized remainder is not proof that the registration promise vanished.
        const activityOnly =
          (scoped.length > 0 || publicationCheck) &&
          scoped.every((claim) => claim.kind === 'activity_followup');
        return activityOnly ? [] : [claim];
      })
    : claims;
  return unsendableReasons(reconcile(remaining, view));
}
