/**
 * A synchronous hold on the auth gate's tabs-bounce, for the one flow that knows
 * its post-sign-in destination BEFORE the token commits: create-account sets it,
 * the just-onboarded user is routed to /connect by the resume hook once the
 * family is provisioned, and the hold is released on every exit path.
 *
 * A module-level ref, not React state, on purpose: state set during the sign-in
 * commit cannot win the same-flush race against the gate's effect (both re-run in
 * one commit, and the gate reads its stale closure) — a ref mutated BEFORE
 * signIn() is visible to the gate's very first pass. The rarer email-verify
 * resume (sign-in screen, draft pending) does not set the hold and keeps the
 * brief tabs interlude; sign-in cannot know a draft exists synchronously.
 */
let hold = false;

export function setPostAuthHold(value: boolean): void {
  hold = value;
}

export function postAuthHold(): boolean {
  return hold;
}
