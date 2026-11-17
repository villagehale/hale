import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAGS, PAYMENT_ENV_ONLY, envEnabled } from '../../packages/flags/src/catalog.ts';
import { forcedOnEnv, formatEnv, isDefaultOff, onValue } from './all-flags-on.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'all-flags-on.mjs');

describe('forcedOnEnv', () => {
  it('sets an on value per parser and leaves default-on flags unset', () => {
    const flags = [
      { key: 'off', env: 'OFF_ENABLED', type: 'boolean', parser: 'exact-true', default: false },
      { key: 'on-flag', env: 'ON_ENABLED', type: 'boolean', parser: 'trimmed-on', default: false },
      {
        key: 'already',
        env: 'ALREADY_ENABLED',
        type: 'boolean',
        parser: 'trimmed-not-false',
        default: true,
      },
      {
        key: 'cadence',
        env: 'CADENCE',
        type: 'multivariate',
        parser: 'multivariate',
        default: 'off',
        onVariant: 'live',
      },
      {
        key: 'reader',
        env: 'READER',
        type: 'multivariate',
        parser: 'multivariate',
        default: 'enforce',
        onVariant: 'enforce',
      },
      {
        key: 'digest',
        env: 'DIGEST',
        type: 'boolean',
        parser: 'exact-true',
        default: false,
        allowlistMode: 'both',
        allowlistEnv: 'DIGEST_ALLOWLIST',
      },
      {
        key: 'narrow',
        env: 'NARROW',
        type: 'boolean',
        parser: 'exact-true',
        default: false,
        allowlistMode: 'narrow',
        allowlistEnv: 'NARROW_ALLOWLIST',
      },
    ];
    expect(forcedOnEnv(flags, [{ env: 'PAY_ENABLED' }])).toEqual({
      OFF_ENABLED: 'true',
      ON_ENABLED: 'on',
      CADENCE: 'live',
      DIGEST: 'true',
      DIGEST_ALLOWLIST: 'forced-on',
      NARROW: 'true',
      PAY_ENABLED: 'true',
    });
    expect(onValue(flags[1])).toBe('on');
    expect(isDefaultOff(flags[2])).toBe(false);
  });

  it('turns every default-off catalog flag on, including payment flags', () => {
    const env = forcedOnEnv(FLAGS, PAYMENT_ENV_ONLY);
    for (const spec of FLAGS) {
      if (!isDefaultOff(spec)) {
        expect(env[spec.env]).toBeUndefined();
        continue;
      }
      expect(envEnabled(spec, undefined, env)).toBe(true);
      if (spec.allowlistMode === 'both') {
        // A named family is on only when its id is on the list. The sentinel
        // opens the process-wide read; it does not open every fixture family.
        expect(envEnabled(spec, 'fam-1', env)).toBe(false);
        expect(envEnabled(spec, 'forced-on', env)).toBe(true);
      } else {
        expect(envEnabled(spec, 'fam-1', env)).toBe(true);
      }
    }
    for (const row of PAYMENT_ENV_ONLY) expect(env[row.env]).toBe('true');
    expect(env.F14_ENABLED).toBe('true');
    expect(env.AUTHORIZED_SIGNUP_ENABLED).toBe('on');
    expect(env.SOCIAL_WATCHLIST).toBe('on');
    expect(env.PROACTIVE_CADENCE).toBe('live');
    expect(env.REGISTRATION_DATE_CHECK).toBe('enforce');
    expect(env.CLAIM_READER_MODE).toBeUndefined();
    expect(env.COACH_BUBBLES_ENABLED).toBeUndefined();
    expect(env.VOICE_DISABLED).toBeUndefined();
    expect(env.MEMORY_DIGEST_APPLY).toBe('true');
    expect(env.MEMORY_DIGEST_FAMILY_ALLOWLIST).toBe('forced-on');
    expect(env.TRAVEL_BRIEF_ENABLED).toBe('true');
    expect(env.TRAVEL_BRIEF_FAMILY_ALLOWLIST).toBeUndefined();
    expect(env.BROWSER_USE_SIGNUP_PAYMENT_ENABLED).toBe('true');
  });
});

describe('all-flags-on CLI', () => {
  it('prints the forced env and applies it to a command', () => {
    const printed = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(printed.status).toBe(0);
    expect(printed.stdout).toBe(`${formatEnv(forcedOnEnv(FLAGS, PAYMENT_ENV_ONLY))}\n`);

    const child = spawnSync(
      process.execPath,
      [
        script,
        '--',
        process.execPath,
        '-e',
        'process.stdout.write(process.env.F14_ENABLED ?? "missing")',
      ],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('true');
  });
});
