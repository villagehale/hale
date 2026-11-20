import type { BrowserUseSecretBinding } from '../browser-use/client';

/** Aliases the agent types. The values sit only in secretBindings, never in the task. */
export const PROVIDER_USERNAME_ALIAS = 'provider_username';
export const PROVIDER_PASSWORD_ALIAS = 'provider_password';
export const PROVIDER_TOTP_ALIAS = 'provider_totp';

export interface CredentialAliases {
  username_alias: typeof PROVIDER_USERNAME_ALIAS;
  password_alias: typeof PROVIDER_PASSWORD_ALIAS;
  totp_alias: typeof PROVIDER_TOTP_ALIAS | null;
}

/** What the Browser Use task may name. Never a secret. */
export function credentialFactAliases(hasTotp: boolean): CredentialAliases {
  return {
    username_alias: PROVIDER_USERNAME_ALIAS,
    password_alias: PROVIDER_PASSWORD_ALIAS,
    totp_alias: hasTotp ? PROVIDER_TOTP_ALIAS : null,
  };
}

/**
 * Run-scoped secrets the agent types by alias on this host only. Callers must
 * not log the result or put it in a prompt, audit row, or test snapshot of values.
 */
export function credentialSecretBindings(input: {
  host: string;
  username: string;
  password: string;
  totp?: string | null;
}): BrowserUseSecretBinding[] {
  const allowedDomains = [input.host];
  const bindings: BrowserUseSecretBinding[] = [
    {
      alias: PROVIDER_USERNAME_ALIAS,
      source: { type: 'inline', value: input.username },
      allowedDomains,
    },
    {
      alias: PROVIDER_PASSWORD_ALIAS,
      source: { type: 'inline', value: input.password },
      allowedDomains,
    },
  ];
  if (input.totp) {
    bindings.push({
      alias: PROVIDER_TOTP_ALIAS,
      source: { type: 'inline', value: input.totp },
      allowedDomains,
    });
  }
  return bindings;
}
