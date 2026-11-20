import { createHash } from 'node:crypto';

/**
 * Sync local evaluation of already-loaded PostHog definitions.
 *
 * posthog-node 5's poller `getFeatureFlag` is async (it may await cohort /
 * dependency I/O). Launch reads must stay synchronous — a hung PostHog cannot
 * sit on a webhook. If the poller is not ready, the flag is missing, or a
 * condition needs properties we do not have, return undefined so isEnabled
 * falls back to the env parser.
 */

const LONG_SCALE = BigInt('0xfffffffffffffff');

export interface LocalFlagCondition {
  properties?: Array<unknown>;
  rollout_percentage?: number;
  variant?: string;
}

export interface LocalFlag {
  key: string;
  active: boolean;
  deleted?: boolean;
  ensure_experience_continuity?: boolean;
  filters?: {
    aggregation_group_type_index?: number;
    groups?: LocalFlagCondition[];
    multivariate?: { variants: Array<{ key: string; rollout_percentage: number }> };
  };
}

export interface LoadedPoller {
  isLocalEvaluationReady?: () => boolean;
  featureFlagsByKey?: Record<string, LocalFlag>;
  groupTypeMapping?: Record<string, string>;
}

/** PostHog's local-eval hash: sha1(key.distinctId[salt])[:15] / 2^60-1. */
export function featureFlagHash(flagKey: string, distinctId: string, salt = ''): number {
  const digest = createHash('sha1').update(`${flagKey}.${distinctId}${salt}`).digest('hex');
  const n = BigInt(`0x${digest.slice(0, 15)}`);
  return Number(n) / Number(LONG_SCALE);
}

function inRollout(flagKey: string, distinctId: string, percentage: number | undefined): boolean {
  if (percentage === undefined || percentage >= 100) return true;
  if (percentage <= 0) return false;
  return featureFlagHash(flagKey, distinctId) <= percentage / 100;
}

function matchingVariant(flag: LocalFlag, distinctId: string): string | true {
  const variants = flag.filters?.multivariate?.variants ?? [];
  if (variants.length === 0) return true;
  const hash = featureFlagHash(flag.key, distinctId, 'variant');
  let cursor = 0;
  for (const variant of variants) {
    const next = cursor + variant.rollout_percentage / 100;
    if (hash >= cursor && hash < next) return variant.key;
    cursor = next;
  }
  return true;
}

export function evaluateLoadedFlag(
  poller: LoadedPoller,
  key: string,
  distinctId: string,
  groups?: Record<string, string>,
): boolean | string | undefined {
  if (poller.isLocalEvaluationReady && !poller.isLocalEvaluationReady()) return undefined;
  const flag = poller.featureFlagsByKey?.[key];
  if (!flag) return undefined;
  if (flag.deleted || !flag.active) return false;
  if (flag.ensure_experience_continuity) return undefined;

  const filters = flag.filters ?? {};
  const aggregation = filters.aggregation_group_type_index;
  let bucketing = distinctId;
  if (aggregation !== undefined) {
    const groupName = poller.groupTypeMapping?.[String(aggregation)];
    if (!groupName) return undefined;
    const groupKey = groups?.[groupName];
    if (!groupKey) return false;
    bucketing = groupKey;
  }

  const conditions = filters.groups ?? [];
  if (conditions.length === 0) return false;

  for (const condition of conditions) {
    if ((condition.properties ?? []).length > 0) {
      // Property / cohort / flag-dependency filters need async or extra context.
      return undefined;
    }
    if (!inRollout(flag.key, bucketing, condition.rollout_percentage)) continue;
    const override = condition.variant;
    if (override && (filters.multivariate?.variants ?? []).some((row) => row.key === override)) {
      return override;
    }
    return matchingVariant(flag, bucketing);
  }
  return false;
}
