/**
 * VIL-395 — remote browser runtime for authorized signup.
 *
 * Off unless SIGNUP_SANDBOX_RUNTIME_ENABLED is exactly `true`. `true\n`, `TRUE`,
 * `1`, and `on` stay off. A trailing newline is the failure mode of
 * `vercel env add` from a piped `echo`: the value prints as true and a
 * truthiness check would start a paid sandbox nobody armed. Set it with
 * `printf '%s'`, and redeploy.
 *
 * This flag does not turn authorized signup on. `AUTHORIZED_SIGNUP_ENABLED`
 * stays a separate exact-`on` gate. Both have to be on before a remote
 * runtime is asked to open a page.
 */
export const SIGNUP_SANDBOX_RUNTIME_ENABLED_ENV = 'SIGNUP_SANDBOX_RUNTIME_ENABLED';

export function signupSandboxRuntimeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SIGNUP_SANDBOX_RUNTIME_ENABLED_ENV] === 'true';
}
