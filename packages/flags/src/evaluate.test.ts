import { afterEach, describe, expect, it } from 'vitest';
import { FLAGS, FLAG_BY_KEY, PAYMENT_ENV_ONLY, parseEnvBoolean } from './catalog.js';
import { flagValue, isEnabled, isFlagKilled, setFlagEvaluatorForTests } from './evaluate.js';
import { hashFamilyIdForEvents, hashFamilyIdForFlags } from './hash.js';
import { evaluateLoadedFlag, featureFlagHash } from './local.js';

afterEach(() => {
  setFlagEvaluatorForTests(null);
});

const ON = { POSTHOG_FLAGS_ENABLED: 'true', POSTHOG_ID_SALT: 'test-salt' };

describe('POSTHOG_FLAGS_ENABLED off (default)', () => {
  it('matches exact-true: trailing newline stays off', () => {
    expect(isEnabled('f14', undefined, {})).toBe(false);
    expect(isEnabled('f14', undefined, { F14_ENABLED: 'true' })).toBe(true);
    expect(isEnabled('f14', undefined, { F14_ENABLED: 'true\n' })).toBe(false);
    expect(isEnabled('f14', undefined, { F14_ENABLED: 'TRUE' })).toBe(false);
  });

  it('matches trimmed-on for authorized signup', () => {
    expect(isEnabled('authorized-signup', undefined, {})).toBe(false);
    expect(isEnabled('authorized-signup', undefined, { AUTHORIZED_SIGNUP_ENABLED: 'on' })).toBe(
      true,
    );
    expect(isEnabled('authorized-signup', undefined, { AUTHORIZED_SIGNUP_ENABLED: ' on ' })).toBe(
      true,
    );
    expect(isEnabled('authorized-signup', undefined, { AUTHORIZED_SIGNUP_ENABLED: 'true' })).toBe(
      false,
    );
  });

  it('matches general-answer default ON; only exact false kills', () => {
    expect(isEnabled('general-answer-search', undefined, {})).toBe(true);
    expect(
      isEnabled('general-answer-search', undefined, { GENERAL_ANSWER_SEARCH_ENABLED: 'false' }),
    ).toBe(false);
    expect(
      isEnabled('general-answer-search', undefined, { GENERAL_ANSWER_SEARCH_ENABLED: 'false\n' }),
    ).toBe(true);
  });

  it('arms F14 from the family allowlist while the global flag is off', () => {
    const env = { F14_FAMILY_ALLOWLIST: 'fam-a, fam-b' };
    expect(isEnabled('f14', 'fam-a', env)).toBe(true);
    expect(isEnabled('f14', 'fam-z', env)).toBe(false);
    expect(isEnabled('f14', undefined, env)).toBe(false);
  });

  it('keeps inbound-burst dark by default and arms one allowlisted family', () => {
    expect(isEnabled('inbound-burst', 'fam-a', {})).toBe(false);
    const env = { INBOUND_BURST_FAMILY_ALLOWLIST: 'fam-a' };
    expect(isEnabled('inbound-burst', 'fam-a', env)).toBe(true);
    expect(isEnabled('inbound-burst', 'fam-b', env)).toBe(false);
    expect(isEnabled('inbound-burst', 'fam-b', { INBOUND_BURST_ENABLED: 'true\n' })).toBe(false);
    expect(isEnabled('inbound-burst', 'fam-b', { INBOUND_BURST_ENABLED: 'true' })).toBe(true);
  });

  it('keeps deep-followup-now dark by default and arms one allowlisted family', () => {
    expect(isEnabled('deep-followup-now', 'fam-a', {})).toBe(false);
    const env = { DEEP_FOLLOWUP_NOW_FAMILY_ALLOWLIST: 'fam-a' };
    expect(isEnabled('deep-followup-now', 'fam-a', env)).toBe(true);
    expect(isEnabled('deep-followup-now', 'fam-b', env)).toBe(false);
    expect(isEnabled('deep-followup-now', 'fam-b', { DEEP_FOLLOWUP_NOW_ENABLED: 'true\n' })).toBe(
      false,
    );
    expect(isEnabled('deep-followup-now', 'fam-b', { DEEP_FOLLOWUP_NOW_ENABLED: 'true' })).toBe(
      true,
    );
  });

  it('does not call the PostHog evaluator', () => {
    let called = 0;
    setFlagEvaluatorForTests(() => {
      called += 1;
      return true;
    });
    expect(isEnabled('f14', 'fam-a', { F14_ENABLED: 'false' })).toBe(false);
    expect(called).toBe(0);
  });
});

describe('kill switch (PostHog path on)', () => {
  it('env false wins over a PostHog true', () => {
    setFlagEvaluatorForTests(() => true);
    expect(isEnabled('f14', 'fam-a', { ...ON, F14_ENABLED: 'false' })).toBe(false);
    expect(isFlagKilled('f14', { ...ON, F14_ENABLED: 'false' })).toBe(true);
  });

  it('env off wins over a PostHog true', () => {
    setFlagEvaluatorForTests(() => true);
    expect(
      isEnabled('authorized-signup', 'fam-a', { ...ON, AUTHORIZED_SIGNUP_ENABLED: 'off' }),
    ).toBe(false);
  });

  it('VOICE_DISABLED=true kills voice even when PostHog says on', () => {
    setFlagEvaluatorForTests(() => true);
    expect(isEnabled('voice', 'fam-a', { ...ON, VOICE_DISABLED: 'true' })).toBe(false);
  });

  it('does not treat unset as a kill', () => {
    setFlagEvaluatorForTests(() => true);
    expect(isEnabled('f14', 'fam-a', { ...ON })).toBe(true);
    expect(isFlagKilled('f14', { ...ON })).toBe(false);
  });

  it('does not apply while POSTHOG_FLAGS_ENABLED is off', () => {
    expect(isFlagKilled('f14', { F14_ENABLED: 'false' })).toBe(false);
  });
});

describe('fallback (PostHog path on)', () => {
  it('falls back to the env value when PostHog is unset', () => {
    setFlagEvaluatorForTests(() => undefined);
    expect(isEnabled('f14', 'fam-a', { ...ON, F14_ENABLED: 'true' })).toBe(true);
    expect(isEnabled('f14', 'fam-a', { ...ON })).toBe(false);
  });

  it('falls back to the env value when PostHog throws', () => {
    setFlagEvaluatorForTests(() => {
      throw new Error('poller down');
    });
    expect(
      isEnabled('browser-use-signup', 'fam-a', { ...ON, BROWSER_USE_SIGNUP_ENABLED: 'true' }),
    ).toBe(true);
    expect(isEnabled('browser-use-signup', 'fam-a', { ...ON })).toBe(false);
  });

  it('falls back to the code default when env is unset', () => {
    setFlagEvaluatorForTests(() => undefined);
    expect(isEnabled('f14', undefined, { ...ON })).toBe(false);
    expect(isEnabled('general-answer-search', undefined, { ...ON })).toBe(true);
    expect(isEnabled('voice', undefined, { ...ON })).toBe(true);
  });

  it('falls back to the family allowlist when PostHog misses', () => {
    setFlagEvaluatorForTests(() => undefined);
    expect(isEnabled('f14', 'fam-a', { ...ON, F14_FAMILY_ALLOWLIST: 'fam-a' })).toBe(true);
  });
});

describe('PostHog evaluation', () => {
  it('uses the HMAC family id and a family group', () => {
    const seen: Array<{ key: string; distinctId: string; groups?: Record<string, string> }> = [];
    setFlagEvaluatorForTests((args) => {
      seen.push(args);
      return true;
    });
    expect(isEnabled('linq-stickers', 'fam-1', { ...ON })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.key).toBe('linq-stickers');
    expect(seen[0]?.distinctId).toBe(hashFamilyIdForFlags('fam-1', 'test-salt'));
    expect(seen[0]?.groups).toEqual({ family: hashFamilyIdForFlags('fam-1', 'test-salt') });
  });

  it('skips PostHog when the salt is missing and a family id was given', () => {
    setFlagEvaluatorForTests(() => true);
    expect(isEnabled('f14', 'fam-a', { POSTHOG_FLAGS_ENABLED: 'true', F14_ENABLED: 'true' })).toBe(
      true,
    );
  });

  it('events and flags share one id when the salt is set; unsalted events stay 16-char', () => {
    const flags = hashFamilyIdForFlags('fam-1', 'test-salt');
    expect(flags).toHaveLength(64);
    expect(hashFamilyIdForEvents('fam-1', 'test-salt')).toBe(flags);
    const unsalted = hashFamilyIdForEvents('fam-1', '');
    expect(unsalted).toHaveLength(16);
    expect(unsalted).not.toBe(flags.slice(0, 16));
  });
});

describe('multivariate claim-reader-mode', () => {
  it('env path: enforce by default; off, trimmed, is the kill; arming values are exact', () => {
    expect(flagValue('claim-reader-mode', undefined, {})).toBe('enforce');
    expect(flagValue('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'shadow' })).toBe(
      'shadow',
    );
    expect(flagValue('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'off' })).toBe('off');
    expect(flagValue('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'off\n' })).toBe('off');
    // The launch kill switch is `=false`, as on every boolean; it kills here too.
    expect(flagValue('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'false' })).toBe('off');
    expect(flagValue('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'false\n' })).toBe('off');
    expect(flagValue('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'shadow\n' })).toBe(
      'enforce',
    );
    expect(isEnabled('claim-reader-mode', undefined, {})).toBe(true);
    expect(isEnabled('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'shadow' })).toBe(true);
    expect(isEnabled('claim-reader-mode', undefined, { CLAIM_READER_MODE: 'off\n' })).toBe(false);
  });

  it('kill switch forces off even when PostHog returns enforce', () => {
    setFlagEvaluatorForTests(() => 'enforce');
    expect(flagValue('claim-reader-mode', 'fam-a', { ...ON, CLAIM_READER_MODE: 'off' })).toBe(
      'off',
    );
    expect(isEnabled('claim-reader-mode', 'fam-a', { ...ON, CLAIM_READER_MODE: 'off' })).toBe(
      false,
    );
  });

  it('a PostHog flag switched off is the off variant, not the default', () => {
    setFlagEvaluatorForTests(() => false);
    expect(flagValue('claim-reader-mode', 'fam-a', { ...ON })).toBe('off');
    expect(isEnabled('claim-reader-mode', 'fam-a', { ...ON })).toBe(false);
  });

  it('PostHog variant wins when the env is not a kill', () => {
    setFlagEvaluatorForTests(() => 'shadow');
    expect(flagValue('claim-reader-mode', 'fam-a', { ...ON })).toBe('shadow');
  });

  it('a default-off multivariate keeps its exact parse', () => {
    expect(flagValue('proactive-cadence', undefined, {})).toBe('off');
    expect(flagValue('proactive-cadence', undefined, { PROACTIVE_CADENCE: 'live\n' })).toBe('off');
    expect(isEnabled('proactive-cadence', undefined, { PROACTIVE_CADENCE: 'live' })).toBe(true);
  });
});

describe('sync local evaluation', () => {
  const hundred: Parameters<typeof evaluateLoadedFlag>[0] = {
    isLocalEvaluationReady: () => true,
    featureFlagsByKey: {
      f14: {
        key: 'f14',
        active: true,
        filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
      },
      'claim-reader-mode': {
        key: 'claim-reader-mode',
        active: true,
        filters: {
          multivariate: {
            variants: [
              { key: 'off', rollout_percentage: 0 },
              { key: 'shadow', rollout_percentage: 0 },
              { key: 'enforce', rollout_percentage: 100 },
            ],
          },
          groups: [{ properties: [], rollout_percentage: 100, variant: 'enforce' }],
        },
      },
    },
  };

  it('returns true for a loaded 100% boolean without awaiting', () => {
    expect(evaluateLoadedFlag(hundred, 'f14', 'fam-hash')).toBe(true);
  });

  it('returns the condition variant for a 100% multivariate', () => {
    expect(evaluateLoadedFlag(hundred, 'claim-reader-mode', 'fam-hash')).toBe('enforce');
  });

  it('falls through when the poller has not loaded', () => {
    expect(
      evaluateLoadedFlag(
        { isLocalEvaluationReady: () => false, featureFlagsByKey: {} },
        'f14',
        'x',
      ),
    ).toBeUndefined();
  });

  it('falls through when the flag is missing (env fallback)', () => {
    expect(evaluateLoadedFlag(hundred, 'linq-stickers', 'x')).toBeUndefined();
  });

  it('does not treat a Promise as on — evaluation is a boolean or string', () => {
    const value = evaluateLoadedFlag(hundred, 'f14', 'x');
    expect(typeof value === 'boolean' || typeof value === 'string' || value === undefined).toBe(
      true,
    );
    expect(value).not.toBeInstanceOf(Promise);
  });

  it('hashes with PostHog sha1 so a 0% rollout is off', () => {
    expect(featureFlagHash('f14', 'fam-hash')).toBeGreaterThan(0);
    expect(
      evaluateLoadedFlag(
        {
          isLocalEvaluationReady: () => true,
          featureFlagsByKey: {
            f14: {
              key: 'f14',
              active: true,
              filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
            },
          },
        },
        'f14',
        'fam-hash',
      ),
    ).toBe(false);
  });
});

describe('catalog', () => {
  it('has unique keys and env names', () => {
    const keys = FLAGS.map((flag) => flag.key);
    const envs = FLAGS.map((flag) => flag.env);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('does not put payment flags on the PostHog catalog', () => {
    const envs = new Set(FLAGS.map((flag) => flag.env));
    for (const row of PAYMENT_ENV_ONLY) {
      expect(envs.has(row.env)).toBe(false);
      expect(row.posthogKey).toBeNull();
    }
  });

  it('pins every parser against its documented on-value', () => {
    expect(parseEnvBoolean(FLAG_BY_KEY.f14, { F14_ENABLED: 'true' })).toBe(true);
    expect(
      parseEnvBoolean(FLAG_BY_KEY['authorized-signup'], { AUTHORIZED_SIGNUP_ENABLED: 'on' }),
    ).toBe(true);
    expect(parseEnvBoolean(FLAG_BY_KEY['linq-stickers'], { LINQ_STICKERS_ENABLED: 'true' })).toBe(
      true,
    );
    expect(parseEnvBoolean(FLAG_BY_KEY.voice, { VOICE_DISABLED: 'true' })).toBe(false);
    expect(parseEnvBoolean(FLAG_BY_KEY.voice, {})).toBe(true);
  });
});
