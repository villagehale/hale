import type { AsideLane } from './guard';

/**
 * The voice pass's dark-launch switch — ONE variable that names the lanes it is armed
 * for, and nothing else.
 *
 * One variable rather than a boolean plus a list, because the two requirements the spec
 * states — off by default, opt in per lane — are the same requirement. Unset, empty, or
 * naming no lane this build knows is off everywhere.
 *
 * IT CANNOT BE SWITCHED ON BY A TRAILING NEWLINE. `vercel env add` from a piped `echo`
 * stores the newline, so a value that prints as `email_alert` is really
 * `'email_alert\n'`; the member is trimmed and must equal a lane name exactly, which is
 * the `f14Allowlist` shape rather than the `=== 'true'` one and defends against the same
 * trap. Set it with `printf '%s' email_alert | vercel env add VOICE_PASS_LANES production`
 * and REDEPLOY — an env var only takes effect on a fresh deployment.
 *
 * It composes with, and never replaces, the two switches above it: `f14EnabledFor` still
 * decides whether the alert is sent at all, and `VOICE_DISABLED` / a missing
 * `ANTHROPIC_API_KEY` still kill every composed voice at once.
 */
export const VOICE_PASS_LANES_ENV = 'VOICE_PASS_LANES';

export function voicePassLanes(): Set<string> {
  return new Set(
    (process.env[VOICE_PASS_LANES_ENV] ?? '')
      .split(',')
      .map((lane) => lane.trim())
      .filter((lane) => lane.length > 0),
  );
}

export function voicePassEnabledFor(lane: AsideLane): boolean {
  return voicePassLanes().has(lane);
}
