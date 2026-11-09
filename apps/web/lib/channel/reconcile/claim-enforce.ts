import type { Database } from '@hale/db';
import { type ClaimShadowContext, loadClaimShadowContext } from './candidate-rows';
import { buildClaimCandidates } from './candidates';
import { type ClaimReadFailure, type ClaimReader, defaultClaimReader } from './claim-reader';
import { type ClaimReadVerdict, type ReadClaimResolution, verifyClaimRead } from './claim-verdict';
import { claimReaderEnforces } from './flag';
import { type ReconcileView, type RegistrationWatchMint, registrationWatchMint } from './reconcile';
import { type Segment, claimReadLocale } from './sentences';

/**
 * VIL-581 PR 3 · the claim reader as part of the DECISION, for a family the flag
 * enforces (flag.ts). The lanes keep main's English regex as a floor: a body is
 * sendable only when the regex verdict AND this verdict are clean, so enforce never
 * sends an English sentence main would refuse.
 *
 * ONE SENTENCE, EVERY CLAIM (VIL-580). The reader lists each claim a sentence makes and
 * code checks each one; a sentence is refused when ANY of its claims is, and the drop
 * unit stays the whole sentence. So a true follow-up can no longer carry a false
 * booking past the gate in the same sentence.
 *
 * A FAILED READ IS NOT A VERDICT. It comes back as `failed` with its named reason, and
 * each lane holds rather than sending text nobody read: a sweep refuses at send, the
 * coach claims the turn (route.ts). It is never a refused claim and never a fallback to
 * the regex alone.
 */

export type ClaimEnforceFailure =
  | ClaimReadFailure
  /** The recipient has no stored zone, so a booking's day and time cannot be checked. */
  | 'no_time_zone';

export type EnforcedRead =
  | {
      status: 'read';
      segments: readonly Segment[];
      verdict: ClaimReadVerdict;
      /** The watch rows this reading lets the send flow write: one per window. */
      mints: readonly RegistrationWatchMint[];
    }
  | { status: 'failed'; reason: ClaimEnforceFailure };

export interface ClaimEnforceInput {
  familyId: string;
  /** The recipient, whose zone dates the rows; null is the primary parent. */
  parentUserId: string | null;
  now: Date;
  body: string;
  /** Coach turns only. */
  inbound?: string;
  view: ReconcileView;
  pending?: { activityFollowup: string | null; spotWatch: string | null };
  signal: AbortSignal;
  budgetMs: number;
}

export interface ClaimEnforcer {
  /** Read on every call: the flag, or the test line's allowlist, decides per family. */
  enforces(familyId: string): boolean;
  read(database: Database, input: ClaimEnforceInput): Promise<EnforcedRead>;
}

export interface ClaimEnforcerPorts {
  enforces: (familyId: string) => boolean;
  reader: ClaimReader;
  loadContext: (
    database: Database,
    input: Parameters<typeof loadClaimShadowContext>[1],
  ) => Promise<ClaimShadowContext>;
}

export function createClaimEnforcer(ports: ClaimEnforcerPorts): ClaimEnforcer {
  return {
    enforces: ports.enforces,
    async read(database, input) {
      const context = await ports.loadContext(database, {
        familyId: input.familyId,
        now: input.now,
        parentUserId: input.parentUserId,
        view: input.view,
        ...(input.pending ? { pending: input.pending } : {}),
      });
      if (context.status === 'skipped') return { status: 'failed', reason: context.reason };
      const candidates = buildClaimCandidates(input.familyId, context.rows, context.timeZone);
      const outcome = await ports.reader.read({
        body: input.body,
        language: context.language,
        timeZone: context.timeZone,
        now: input.now,
        ...(input.inbound !== undefined ? { inbound: input.inbound } : {}),
        candidates,
        signal: input.signal,
        budgetMs: input.budgetMs,
      });
      if (outcome.status === 'failed') return { status: 'failed', reason: outcome.reason };
      const verdict = verifyClaimRead(outcome, {
        candidates,
        locale: claimReadLocale(context.language),
        timeZone: context.timeZone,
      });
      return {
        status: 'read',
        segments: outcome.segments,
        verdict,
        mints: verdict.mints.length > 0 ? [mintFor(input.view)] : [],
      };
    },
  };
}

/** The w1 alias is built from the view's own window, so a mint without one is a bug. */
function mintFor(view: ReconcileView): RegistrationWatchMint {
  if (!view.mintableWindow) {
    throw new Error('claim enforce: a mint was cited with no mintable window in view');
  }
  return registrationWatchMint(view.mintableWindow);
}

export const refusedResolutions = (verdict: ClaimReadVerdict) =>
  verdict.resolutions.filter(
    (r): r is Extract<ReadClaimResolution, { status: 'refused' }> => r.status === 'refused',
  );

let shared: ClaimEnforcer | undefined;

/** One per process. Nothing here opens a connection or reads a required env: it is a
 * default argument on every gated send, and `off` must cost nothing. */
export function defaultClaimEnforcer(): ClaimEnforcer {
  shared ??= createClaimEnforcer({
    enforces: (familyId) => claimReaderEnforces(familyId),
    reader: defaultClaimReader('adaptive'),
    loadContext: loadClaimShadowContext,
  });
  return shared;
}
