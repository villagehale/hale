/**
 * Beta invite gate decision. Pure so middleware stays thin and the policy is
 * unit-tested in isolation. Fails CLOSED (rule #1): a misconfigured gate (invite
 * required but no code set) denies rather than letting anyone through.
 *
 * Dropped at public launch by setting BETA_INVITE_ONLY=false → every request is
 * `open` and the code/cookie are never consulted.
 */
export type InviteGateDecision =
  | { kind: 'open' } // gate off — public launch
  | { kind: 'allow' } // already-invited (valid cookie)
  | { kind: 'grant' } // valid ?invite= code — caller sets the cookie, then allows
  | { kind: 'deny' }; // no valid invite — caller redirects to the waitlist

export function inviteGateDecision(input: {
  inviteOnly: boolean;
  code: string | undefined;
  param: string | null;
  cookie: string | undefined;
}): InviteGateDecision {
  if (!input.inviteOnly) {
    return { kind: 'open' };
  }
  if (!input.code) {
    return { kind: 'deny' };
  }
  if (input.param === input.code) {
    return { kind: 'grant' };
  }
  if (input.cookie === input.code) {
    return { kind: 'allow' };
  }
  return { kind: 'deny' };
}
