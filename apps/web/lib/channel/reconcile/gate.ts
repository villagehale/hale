import type { Database } from '@hale/db';
import { type ClaimEnforcer, defaultClaimEnforcer, refusedResolutions } from './claim-enforce';
import { CLAIM_READ_MAX_BUDGET_MS } from './claim-reader';
import { type ClaimShadow, type ClaimShadowLane, defaultClaimShadow } from './claim-shadow';
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
  | 'unrecorded_promise'
  /** VIL-581 enforce: the claim reader could not read this body, so it is not sent
   * unread. The read's own reason is logged; the next tick tries again. */
  | 'claim_read_failed';

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
 *
 * VIL-581: for a family the flag does not enforce, the claim reader SHADOWS the
 * decision. It is handed the verdict after the decision is made and starts detached
 * (claim-shadow.ts); what this returns never depends on it. For an enforced family the
 * reader's verdict joins the regex's (claim-enforce.ts). `lane` and `parentUserId` only label and place that read: a caller
 * that names neither is the unlabelled sweep, read in the primary parent's zone.
 */
export async function refuseUnbackedSend(
  database: Database,
  input: {
    familyId: string;
    body: string;
    now: Date;
    lane?: Exclude<ClaimShadowLane, 'coach' | 'dispatch' | 'sweep_unlabelled'>;
    parentUserId?: string;
  },
  shadow: ClaimShadow = defaultClaimShadow(),
  enforcer: ClaimEnforcer = defaultClaimEnforcer(),
): Promise<SendRefusalReason[]> {
  if (enforcer.enforces(input.familyId)) return enforcedReasons(database, input, enforcer);
  const shadowed = {
    lane: input.lane ?? 'sweep_unlabelled',
    familyId: input.familyId,
    parentUserId: input.parentUserId ?? null,
    body: input.body,
    now: input.now,
  } as const;
  const claims = extractStateClaims(input.body);
  // NO CLAIM, NO QUERY. The overwhelming majority of bodies assert nothing this
  // primitive owns, and those must not cost a sweep four selects per message.
  if (claims.length === 0) {
    shadow.sweep(database, { ...shadowed, verdict: null, view: null });
    return [];
  }
  const view = await loadReconcileView(database, { familyId: input.familyId, now: input.now });
  const verdict = reconcile(claims, view);
  shadow.sweep(database, { ...shadowed, verdict, view });
  return unsendableReasons(verdict);
}

/**
 * VIL-581 enforce: the regex verdict is the floor and the reader's verdict joins it, so
 * the body goes only when both are clean. Every body is read, claim or not: "no regex
 * claim" says nothing in French. A mint stays a refusal here (above), and a read that
 * failed is its own named refusal, never a pass.
 */
async function enforcedReasons(
  database: Database,
  input: Parameters<typeof refuseUnbackedSend>[1],
  enforcer: ClaimEnforcer,
): Promise<SendRefusalReason[]> {
  const view = await loadReconcileView(database, { familyId: input.familyId, now: input.now });
  const floor = unsendableReasons(reconcile(extractStateClaims(input.body), view));
  const read = await enforcer.read(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId ?? null,
    now: input.now,
    body: input.body,
    view,
    // A sweep has no turn deadline; the reader's own budget is the only one.
    signal: new AbortController().signal,
    budgetMs: CLAIM_READ_MAX_BUDGET_MS,
  });
  if (read.status === 'failed') {
    console.error(
      {
        event: 'claim_read_enforce_failed',
        lane: input.lane ?? 'sweep_unlabelled',
        reason: read.reason,
      },
      'reconcile gate: the claim reader could not read the body - not sent',
    );
    return [...floor, 'claim_read_failed'];
  }
  return [
    ...floor,
    ...refusedResolutions(read.verdict).map((resolution) => resolution.reason),
    ...read.mints.map(() => 'unrecorded_promise' as const),
  ];
}
