import type { CommitmentKind } from '~/lib/commitments/ledger';
import type { ClaimKind, StateClaim } from './claims';

/**
 * VIL-293 · THE RECONCILIATION PRIMITIVE, half two — is the claim TRUE?
 *
 * THE INVARIANT, in one line: no sentence claiming a row leaves Hale unless the row
 * exists, is about to exist, or can be made to exist right here.
 *
 * THREE OUTCOMES, and the middle one is the whole idea. Before this, a lane could only
 * check ("is there a row?") and refuse. Checking alone is why the 2026-08-21 turn was
 * unfixable in the direction anyone wanted: the parent asked Hale to watch a
 * registration morning, Hale said yes, and the honest gate would have DELETED that
 * sentence — turning a promise into a shrug. The parent wanted the watch. So the third
 * outcome is to KEEP the promise by minting the row in the same flow as the send.
 *
 *   MATCHED — a row already backs it, or this very send is going to write one.
 *   MINTED  — no row yet, but the facts in view make one mechanically: a matched
 *             municipal window plus an armed ladder IS the watch, and the ledger row is
 *             the part that was missing.
 *   REFUSED — neither, and nothing here can invent it. Typed, counted, never silent.
 *
 * PURE. It takes a view and returns verdicts; it opens no connection and writes no row.
 * The mint is DESCRIBED here and PERFORMED by the caller after the transport accepts,
 * because a promise is minted against the outbound message that carried it (MEM-10) and
 * that row does not exist yet at the moment this function runs.
 */

/** What a lane could read about this family before it decided to send. */
export interface ReconcileView {
  /** Hale's open promises on the MEM-10 ledger, by kind. */
  openKinds: ReadonlySet<CommitmentKind>;
  /**
   * What THIS send is already going to write once the transport accepts — the coach's
   * `onPromise`/`onOffer` registrations. Separate from {@link openKinds} rather than
   * unioned into it because "the row exists" and "the row is one send away" are
   * different facts, and a log that cannot tell them apart cannot tell a working tool
   * call from a stale debt (rule #11).
   */
  pendingKinds: ReadonlySet<CommitmentKind>;
  /**
   * The registration ladder is already running for this family: a live
   * `registration_sequences` row. It is what makes the ladder's own legs true — they
   * say Hale is on the morning because Hale is.
   */
  registrationLaddered: boolean;
  /**
   * A hand-verified municipal window this family still has time to act on, with the
   * ladder armed for them. The fact a watch promise can be minted AGAINST: null means
   * either no window matched or the sweep is dark for this household, and in both cases
   * there is nothing to watch with.
   */
  mintableWindow: MintableWindow | null;
  /**
   * Live, undeleted placements on this family's calendar — titles only. What a
   * "that's booked" is checked against. Empty means nothing is on the calendar at all,
   * which makes every booking claim false by inspection.
   */
  scheduledTitles: readonly string[];
  /**
   * The appointments the PARENT told Hale are booked — what they said, kept as a row
   * (VIL-294; health/reply.ts loadStatedBookings).
   *
   * A SECOND FIELD RATHER THAN MORE TITLES, because they are different facts and a
   * verdict that could not tell them apart would be lying about which. `scheduledTitles`
   * is Hale's own calendar: rows Hale wrote, with times, that Hale can move. This is a
   * parent's sentence: an appointment Hale has never seen, holds no time for, and cannot
   * change. Hale may confirm it back and may not act on it, and the `matchedBy` is what
   * lets a reader downstream know which of the two backed a sentence.
   *
   * Empty is the ordinary case. A 13+ child's appointment is never in here (rule #1),
   * which fails closed: the claim simply goes unbacked and the gate drops the sentence.
   */
  statedBookings: readonly string[];
}

export interface MintableWindow {
  /** `Halton Hills`, as a parent says it. */
  town: string;
  /** When THIS family can first register — the instant the promise comes due, because
   * past it "I'll text you before it opens" is no longer a thing that can happen. */
  opensForFamilyAt: Date;
}

/** A ledger row the send flow is being asked to write, described but not yet written. */
export interface RegistrationWatchMint {
  kind: Extract<CommitmentKind, 'registration_watch'>;
  /** The promise in one short, parent-safe sentence. A town and a cycle, no child's
   * name — the same rule the ladder's own summary keeps (rule #1). */
  summary: string;
  dueAt: Date;
}

/** WHY a claim could not be backed. A closed vocabulary, because this string is the
 * only account anything downstream gets of a sentence Hale was not allowed to send. */
export type RefusalReason =
  /** A promise about Hale's own behaviour. No table exists and none could. */
  | 'self_referential'
  /** A watch promise with no live ladder and no window to arm one against. */
  | 'no_registration_watch'
  /** "I'll come back with what I find" and the promise tool was never called. */
  | 'no_activity_promise'
  /** A booking claim with nothing on the calendar it could be about. */
  | 'no_scheduled_row';

export type ClaimResolution =
  | {
      claim: StateClaim;
      status: 'matched';
      matchedBy:
        | 'open_commitment'
        | 'pending_commitment'
        | 'live_sequence'
        | 'scheduled_row'
        | 'parent_stated';
    }
  | { claim: StateClaim; status: 'minted'; mint: RegistrationWatchMint }
  | { claim: StateClaim; status: 'refused'; reason: RefusalReason };

export interface ReconcileVerdict {
  resolutions: readonly ClaimResolution[];
  /** The subset that could not be backed. Empty means the body may go on the wire. */
  refused: readonly Extract<ClaimResolution, { status: 'refused' }>[];
  /** The rows the caller must write once the send lands. */
  mints: readonly RegistrationWatchMint[];
}

/** The one sentence a model is told about each refusal, in the second person it will
 * act on. Named per reason rather than assembled from the claim, so a re-ask says what
 * is WRONG rather than quoting the sentence back and inviting a paraphrase of it. */
const VIOLATION: Record<RefusalReason, string> = {
  self_referential:
    'The message promises to change how Hale itself behaves. Nothing in the system can record or keep that promise, so it would be false the moment it was sent. Answer the question and say nothing about your own messages.',
  no_registration_watch:
    'The message says Hale is watching a registration or will text before one opens. No registration window is being watched for this family, and no ladder is running. Either say what the published date is, or say nothing about watching.',
  no_activity_promise:
    'The message promises to come back with activities or finds, and no such promise was registered. Call promise_activity_followup so a sweep actually comes back, or hand over what you already have and stop.',
  no_scheduled_row:
    'The message says something is booked or on the calendar. Nothing on this family\'s calendar matches and the parent has not told you it is booked, so that is a claim about a row that does not exist. Say what would need to happen instead.',
};

function resolveOne(claim: StateClaim, view: ReconcileView): ClaimResolution {
  const kind: ClaimKind = claim.kind;
  if (kind === 'self_referential') {
    return { claim, status: 'refused', reason: 'self_referential' };
  }
  if (kind === 'registration_watch') {
    if (view.pendingKinds.has('registration_watch')) {
      return { claim, status: 'matched', matchedBy: 'pending_commitment' };
    }
    if (view.openKinds.has('registration_watch')) {
      return { claim, status: 'matched', matchedBy: 'open_commitment' };
    }
    if (view.registrationLaddered) {
      return { claim, status: 'matched', matchedBy: 'live_sequence' };
    }
    const window = view.mintableWindow;
    if (window) {
      return {
        claim,
        status: 'minted',
        mint: {
          kind: 'registration_watch',
          summary: `${window.town} registration: a text before it opens.`,
          dueAt: window.opensForFamilyAt,
        },
      };
    }
    return { claim, status: 'refused', reason: 'no_registration_watch' };
  }
  if (kind === 'activity_followup') {
    if (view.pendingKinds.has('activity_followup')) {
      return { claim, status: 'matched', matchedBy: 'pending_commitment' };
    }
    if (view.openKinds.has('activity_followup')) {
      return { claim, status: 'matched', matchedBy: 'open_commitment' };
    }
    return { claim, status: 'refused', reason: 'no_activity_promise' };
  }
  // A booking claim is matched on ITS OWN WORDS rather than on a kind, because the thing
  // it points at is a placement and placements have no kind — one content word shared
  // with a live title is the whole test. A family with nothing on the calendar therefore
  // fails it by inspection, which is the 2026-08-22 sentence.
  const shares = (candidate: string) => {
    const words = candidate.toLowerCase();
    return claim.words.some((word) => words.includes(word));
  };
  // The calendar is asked FIRST, so a claim two things could back is attributed to the
  // stronger one — a row Hale wrote and can act on, rather than a sentence it was told.
  if (view.scheduledTitles.some(shares)) {
    return { claim, status: 'matched', matchedBy: 'scheduled_row' };
  }
  if (view.statedBookings.some(shares)) {
    return { claim, status: 'matched', matchedBy: 'parent_stated' };
  }
  return { claim, status: 'refused', reason: 'no_scheduled_row' };
}

export function reconcile(
  claims: readonly StateClaim[],
  view: ReconcileView,
): ReconcileVerdict {
  const resolutions = claims.map((claim) => resolveOne(claim, view));
  return {
    resolutions,
    refused: resolutions.filter(
      (resolution): resolution is Extract<ClaimResolution, { status: 'refused' }> =>
        resolution.status === 'refused',
    ),
    mints: resolutions.flatMap((resolution) =>
      resolution.status === 'minted' ? [resolution.mint] : [],
    ),
  };
}

/**
 * What to tell a model that has to write the message again — the #529 composer's shape,
 * reused rather than re-invented: a list of violations, deduplicated, in the order they
 * appeared. Empty when nothing was refused, which is the caller's signal to send.
 */
export function reconcileViolations(verdict: ReconcileVerdict): string[] {
  return [...new Set(verdict.refused.map((resolution) => VIOLATION[resolution.reason]))];
}

/**
 * The body with every refused sentence cut out — the last honest move for a lane that
 * has already re-asked and cannot refuse to reply at all.
 *
 * It is a SUBTRACTION and never a rewrite: the spans come from the extractor, so what
 * survives is verbatim what the model wrote minus the sentences nothing backs. An empty
 * result means the whole reply was unbacked, and the caller must treat that as a failed
 * turn rather than sending a blank text.
 */
export function withoutRefusedClaims(body: string, verdict: ReconcileVerdict): string {
  let survivor = body;
  for (const resolution of verdict.refused) {
    survivor = survivor.replace(resolution.claim.sentence, ' ');
  }
  return survivor.replace(/\s+/g, ' ').trim();
}
