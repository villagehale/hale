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
 * transport is unchecked by construction — the 2026-08-22 lesson from `withOptOut` and
 * `withSharePage` appending past a green gate (activity/sweep.ts).
 */

/** Why the wire body was refused. The reconcile's own reasons, plus the one this gate
 * adds for a promise a sweep would have had to write and cannot. */
export type SendRefusalReason = ReconcileVerdict['refused'][number]['reason'] | 'unrecorded_promise';

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
  input: { familyId: string; body: string; now: Date },
): Promise<SendRefusalReason[]> {
  const claims = extractStateClaims(input.body);
  // NO CLAIM, NO QUERY. The overwhelming majority of bodies assert nothing this
  // primitive owns, and those must not cost a sweep four selects per message.
  if (claims.length === 0) return [];
  const view = await loadReconcileView(database, { familyId: input.familyId, now: input.now });
  return unsendableReasons(reconcile(claims, view));
}
