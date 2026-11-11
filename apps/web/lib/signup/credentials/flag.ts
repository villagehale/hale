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
