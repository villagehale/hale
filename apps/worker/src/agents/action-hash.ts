import { createHash } from 'node:crypto';

/**
 * The idempotency key stamped onto a drafted action's payload as `action_hash`,
 * which check_action_idempotency matches on to detect a re-issue of the SAME
 * action (actions.payload->>'action_hash'). Deterministic per (family, action
 * type, semantic identity) so a re-accept of one activity dedups while distinct
 * activities stay apart. Mirrors dedupHashFor's sha256(pipe-joined) shape — the
 * value is never surfaced (rule #1: identity ids, no precise location).
 */
export function computeActionHash(familyId: string, actionType: string, identity: string): string {
  return createHash('sha256').update(`${familyId}|${actionType}|${identity}`).digest('hex');
}
