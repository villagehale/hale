/**
 * VIL-106 — interest passport.
 *
 * Off unless INTEREST_PASSPORT_ENABLED is exactly the string `true`. A
 * trailing newline, `TRUE`, `on`, and `1` stay off. Unset stays off.
 */
export const INTEREST_PASSPORT_ENABLED_ENV = 'INTEREST_PASSPORT_ENABLED';

export function interestPassportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[INTEREST_PASSPORT_ENABLED_ENV] === 'true';
}
