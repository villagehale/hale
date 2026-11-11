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
export {
  DEFAULT_POSTHOG_HOST,
  flagsClient,
  flagsPoller,
  posthogHost,
  posthogProjectKey,
  resetFlagsClientForTests,
} from './client.js';
export {
  flagValue,
  isEnabled,
  isFlagKilled,
  posthogFlagsPathEnabled,
  setFlagEvaluatorForTests,
  type EnvBag,
  type FlagEvaluator,
} from './evaluate.js';
export {
  POSTHOG_ID_SALT_ENV,
  hashFamilyIdForEvents,
  hashFamilyIdForFlags,
} from './hash.js';
export { syncFlags, type SyncOptions, type SyncResult } from './sync.js';
