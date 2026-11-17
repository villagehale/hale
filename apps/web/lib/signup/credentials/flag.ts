/**
 * Encrypted city-site username / password / TOTP. Off unless exactly `true`.
 * Decrypt only inside a Browser Use login run.
 */
import { isEnabled } from '@hale/flags';

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
 * saved it is the parent whose plan is running. Off unless exactly `true`.
 * There is no share grant: a co-parent's plan does not receive the other
 * parent's username, password, TOTP, or captured session.
 */
export const PLAN_CITY_LOGIN_OWNER_ENABLED_ENV = 'PLAN_CITY_LOGIN_OWNER_ENABLED';

export function planCityLoginOwnerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('plan-city-login-owner', undefined, env);
}
