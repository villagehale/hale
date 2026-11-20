/**
 * Browser / client webpack stub. No node:crypto, no posthog-node.
 *
 * Client components never evaluate launch flags; they import server actions that
 * do. Webpack still traces the import, so this file is the `browser` export:
 * env parsers only, matching POSTHOG_FLAGS_ENABLED off.
 */

import { envEnabled, envVariant, getFlag } from './catalog.js';

export {
  FLAG_BY_ENV,
  FLAG_BY_KEY,
  FLAGS,
  PAYMENT_ENV_ONLY,
  POSTHOG_FEATURE_FLAGS_KEY_ENV,
  POSTHOG_FLAGS_ENABLED_ENV,
  envEnabled,
  envVariant,
  getFlag,
  parseAllowlist,
  parseEnvBoolean,
  type AllowlistMode,
  type FlagKey,
  type FlagParser,
  type FlagSpec,
} from './catalog.js';

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
export const POSTHOG_ID_SALT_ENV = 'POSTHOG_ID_SALT';

export type EnvBag = Record<string, string | undefined>;
export type FlagEvaluator = (args: {
  key: string;
  distinctId: string;
  groups?: Record<string, string>;
}) => boolean | string | undefined;

export function posthogHost(env: EnvBag = process.env): string {
  return env.POSTHOG_HOST || env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
}

export function posthogProjectKey(_env: EnvBag = process.env): string | undefined {
  return undefined;
}

export function flagsClient(_env: EnvBag = process.env): null {
  return null;
}

export function flagsPoller(_env: EnvBag = process.env): undefined {
  return undefined;
}

export function resetFlagsClientForTests(): void {}

export function posthogFlagsPathEnabled(_env: EnvBag = process.env): boolean {
  return false;
}

export function isFlagKilled(_flagKey: string, _env: EnvBag = process.env): boolean {
  return false;
}

export function setFlagEvaluatorForTests(_fn: FlagEvaluator | null): void {}

export function isEnabled(flagKey: string, familyId?: string, env: EnvBag = process.env): boolean {
  return envEnabled(getFlag(flagKey), familyId, env);
}

export function flagValue(flagKey: string, familyId?: string, env: EnvBag = process.env): string {
  const spec = getFlag(flagKey);
  if (spec.type !== 'multivariate' || !spec.variants) {
    return isEnabled(flagKey, familyId, env) ? 'true' : 'false';
  }
  return envVariant(spec, env);
}

export function hashFamilyIdForFlags(_familyId: string, _salt: string): string {
  throw new Error('@hale/flags: HMAC hashing is server-only');
}

export function hashFamilyIdForEvents(_familyId: string, _salt?: string): string {
  throw new Error('@hale/flags: event hashing is server-only');
}

export async function syncFlags(): Promise<never> {
  throw new Error('@hale/flags: sync is server-only');
}

export type SyncOptions = Record<string, never>;
export type SyncResult = { dry: boolean; flags: never[] };
