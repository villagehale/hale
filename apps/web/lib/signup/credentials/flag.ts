/**
 * Encrypted city-site username / password / TOTP. Off unless exactly `true`.
 * Decrypt only inside a Browser Use login run.
 */
export const PROVIDER_CREDENTIALS_ENABLED_ENV = 'PROVIDER_CREDENTIALS_ENABLED';

export function providerCredentialsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PROVIDER_CREDENTIALS_ENABLED_ENV] === 'true';
}

/**
 * Generic Browser Use may create a provider account after an explicit parent OK.
 * Off unless exactly `true`.
 */
export const PROVIDER_ACCOUNT_CREATE_ENABLED_ENV = 'PROVIDER_ACCOUNT_CREATE_ENABLED';

export function providerAccountCreateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PROVIDER_ACCOUNT_CREATE_ENABLED_ENV] === 'true';
}

/**
 * VIL-704 · a plan run may use a saved city login only when the parent who
 * saved it is the parent whose plan is running. Env-only, off unless exactly
 * `true`. Nothing in PostHog may turn this on. There is no share grant.
 */
export const PLAN_CITY_LOGIN_OWNER_ENABLED_ENV = 'PLAN_CITY_LOGIN_OWNER_ENABLED';

export function planCityLoginOwnerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PLAN_CITY_LOGIN_OWNER_ENABLED_ENV] === 'true';
}
