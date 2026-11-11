import type { Database } from '@hale/db';
import { captureAgentError } from '~/lib/analytics/server-capture';
import { type ClaimShadowContext, loadClaimShadowContext } from './candidate-rows';
import { buildClaimCandidates } from './candidates';
import {
  CLAIM_READ_MAX_BUDGET_MS,
  type ClaimReadFailure,
  type ClaimReader,
  defaultClaimReader,
} from './claim-reader';
import { type ClaimReadVerdict, type ReadClaimResolution, verifyClaimRead } from './claim-verdict';
import { claimReaderEnforces } from './flag';
import { type ReconcileView, type RegistrationWatchMint, registrationWatchMint } from './reconcile';
import { defaultClaimEnforcerSlot, setDefaultClaimEnforcer } from './claim-enforce-slot';
import { type Segment, claimReadLocale } from './sentences';
import { loadReconcileView } from './view';

export { setDefaultClaimEnforcer };

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

async function reportClaimReadFailed(familyId: string, reason: ClaimEnforceFailure): Promise<void> {
  await captureAgentError({ lane: 'claim_read', reason, familyId });
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
      if (context.status === 'skipped') {
        await reportClaimReadFailed(input.familyId, context.reason);
        return { status: 'failed', reason: context.reason };
      }
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
      if (outcome.status === 'failed') {
        await reportClaimReadFailed(input.familyId, outcome.reason);
        return { status: 'failed', reason: outcome.reason };
      }
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

/**
 * VIL-581 · dispatch failures that should come back. A drain retry can recover a
 * provider blip; a missing zone, an oversize body, or a lane that cannot call will
 * fail the same way on the next tick.
 */
export function isRetryableClaimReadFailure(reason: ClaimEnforceFailure): boolean {
  switch (reason) {
    case 'unreachable':
    case 'rate_limited':
    case 'incident':
    case 'no_budget':
    case 'truncated':
    case 'unparseable':
    case 'provider_rejected':
      return true;
    case 'refused':
    case 'lane_unavailable':
    case 'oversize':
    case 'no_time_zone':
      return false;
  }
}

export type DispatchClaimDecision =
  | { status: 'off' }
  | { status: 'clean' }
  | { status: 'unbacked' }
  | { status: 'failed'; reason: ClaimEnforceFailure; retry: boolean };

/** The dispatch seam holds no database; wiring.ts binds this port to its handle. */
export interface DispatchClaimEnforce {
  enforces(familyId: string): boolean;
  decide(input: {
    familyId: string;
    parentUserId: string;
    body: string;
    now: Date;
  }): Promise<DispatchClaimDecision>;
}

/** One per process. Nothing here opens a connection or reads a required env: it is a
 * default argument on every gated send, and `off` must cost nothing. */
export function defaultClaimEnforcer(): ClaimEnforcer {
  const installed = defaultClaimEnforcerSlot();
  if (installed) return installed;
  const created = createClaimEnforcer({
    enforces: (familyId) => claimReaderEnforces(familyId),
    reader: defaultClaimReader('adaptive'),
    loadContext: loadClaimShadowContext,
  });
  setDefaultClaimEnforcer(created);
  return created;
}

export function bindDispatchClaimEnforce(
  database: Database,
  enforcer: ClaimEnforcer = defaultClaimEnforcer(),
): DispatchClaimEnforce {
  return {
    enforces: (familyId) => enforcer.enforces(familyId),
    async decide(input) {
      if (!enforcer.enforces(input.familyId)) return { status: 'off' };
      const view = await loadReconcileView(database, {
        familyId: input.familyId,
        now: input.now,
      });
      const read = await enforcer.read(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        now: input.now,
        body: input.body,
        view,
        signal: new AbortController().signal,
        budgetMs: CLAIM_READ_MAX_BUDGET_MS,
      });
      if (read.status === 'failed') {
        return {
          status: 'failed',
          reason: read.reason,
          retry: isRetryableClaimReadFailure(read.reason),
        };
      }
      if (refusedResolutions(read.verdict).length > 0 || read.mints.length > 0) {
        return { status: 'unbacked' };
      }
      return { status: 'clean' };
    },
  };
}
