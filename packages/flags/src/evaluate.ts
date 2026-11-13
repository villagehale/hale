import {
  type FlagKey,
  type FlagSpec,
  POSTHOG_FLAGS_ENABLED_ENV,
  envEnabled,
  envVariant,
  getFlag,
  offVariantOf,
} from './catalog.js';
import { flagsPoller } from './client.js';
import { POSTHOG_ID_SALT_ENV, hashFamilyIdForFlags } from './hash.js';
import { evaluateLoadedFlag } from './local.js';

export type EnvBag = Record<string, string | undefined>;

export type FlagEvaluator = (args: {
  key: string;
  distinctId: string;
  groups?: Record<string, string>;
}) => boolean | string | undefined;

let injected: FlagEvaluator | null = null;

/** Test seam: a hung or missing PostHog must not be required to pin precedence. */
export function setFlagEvaluatorForTests(fn: FlagEvaluator | null): void {
  injected = fn;
}

export function posthogFlagsPathEnabled(env: EnvBag = process.env): boolean {
  return env[POSTHOG_FLAGS_ENABLED_ENV] === 'true';
}

/**
 * Explicit env kill. Only on the PostHog path — while POSTHOG_FLAGS_ENABLED is
 * off, parsers (and allowlists) stay exactly as they are today.
 *
 * `VOICE_DISABLED` is inverted: `true` is the kill. Every other flag treats a
 * trimmed `false` or `off` as the kill.
 */
export function isFlagKilled(flagKey: FlagKey | string, env: EnvBag = process.env): boolean {
  if (!posthogFlagsPathEnabled(env)) return false;
  const spec = getFlag(flagKey);
  const raw = env[spec.env];
  if (raw === undefined) return false;
  if (spec.parser === 'inverted-disabled') return raw === 'true';
  const trimmed = raw.trim();
  return trimmed === 'false' || trimmed === 'off';
}

function identity(
  familyId: string | undefined,
  env: EnvBag,
): { distinctId: string; groups?: Record<string, string> } | null {
  if (!familyId) return { distinctId: 'hale-process' };
  const salt = env[POSTHOG_ID_SALT_ENV];
  if (!salt) return null;
  const hashed = hashFamilyIdForFlags(familyId, salt);
  return { distinctId: hashed, groups: { family: hashed } };
}

function fromPosthog(
  spec: FlagSpec,
  familyId: string | undefined,
  env: EnvBag,
): boolean | string | undefined {
  if (injected) {
    const id = identity(familyId, env);
    if (!id) return undefined;
    try {
      return injected({ key: spec.posthogKey, distinctId: id.distinctId, groups: id.groups });
    } catch {
      return undefined;
    }
  }
  const poller = flagsPoller(env);
  if (!poller) return undefined;
  const id = identity(familyId, env);
  if (!id) return undefined;
  try {
    return evaluateLoadedFlag(poller, spec.posthogKey, id.distinctId, id.groups);
  } catch {
    return undefined;
  }
}

function asBoolean(spec: FlagSpec, value: boolean | string): boolean {
  if (spec.type === 'multivariate') {
    if (typeof value === 'string') return value !== offVariantOf(spec);
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === 'false' || trimmed === 'off') return false;
    if (trimmed === 'true' || trimmed === 'on') return true;
    if (spec.variants?.includes(trimmed)) return trimmed !== spec.default;
    return false;
  }
  return value;
}

/**
 * Single chokepoint for launch flags.
 *
 * 1. POSTHOG_FLAGS_ENABLED off (the default) → today's env parser, including
 *    allowlists. PostHog is not touched.
 * 2. Env explicitly `false`/`off` (or `true` on VOICE_DISABLED) → OFF, even
 *    when PostHog would return true.
 * 3. Otherwise the local PostHog poller for this family (HMAC distinct_id +
 *    `family` group).
 * 4. Unset / timeout / error → env parser, else the code default.
 */
export function isEnabled(
  flagKey: FlagKey | string,
  familyId?: string,
  env: EnvBag = process.env,
): boolean {
  const spec = getFlag(flagKey);
  if (!posthogFlagsPathEnabled(env)) return envEnabled(spec, familyId, env);
  if (isFlagKilled(flagKey, env)) return false;
  const evaluated = fromPosthog(spec, familyId, env);
  if (evaluated === undefined) return envEnabled(spec, familyId, env);
  return asBoolean(spec, evaluated);
}

/**
 * Multivariate (and boolean-as-string) reader. Kill and fallback match
 * {@link isEnabled}. Unknown variants fall through to the env / default.
 */
export function flagValue(
  flagKey: FlagKey | string,
  familyId?: string,
  env: EnvBag = process.env,
): string {
  const spec = getFlag(flagKey);
  if (spec.type !== 'multivariate' || !spec.variants) {
    return isEnabled(flagKey, familyId, env) ? 'true' : 'false';
  }
  if (!posthogFlagsPathEnabled(env)) return envVariant(spec, env);
  if (isFlagKilled(flagKey, env)) return offVariantOf(spec);
  const evaluated = fromPosthog(spec, familyId, env);
  if (evaluated === undefined) return envVariant(spec, env);
  if (typeof evaluated === 'string' && spec.variants.includes(evaluated)) return evaluated;
  if (evaluated === true && spec.onVariant) return spec.onVariant;
  if (evaluated === false) return offVariantOf(spec);
  return envVariant(spec, env);
}
