import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAGS, PAYMENT_ENV_ONLY, envEnabled } from '../../packages/flags/src/catalog.ts';
import { forcedOnEnv, formatEnv, isDefaultOff, launchSetEnv, onValue } from './all-flags-on.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'all-flags-on.mjs');

const HELD_OFF_AT_LAUNCH = [
  'HOLIDAY_PROMO_ENABLED',
  'PROMO_NEW_VISITOR_CHECKOUT_ENABLED',
  'META_CAPI_ENABLED',
  'CONVERSIONS_API_ENABLED',
  'CHECKOUT_SERVER_CURRENCY_ENABLED',
  'STRIPE_BILLING_REVOKE_ENABLED',
  'LINQ_APP_CLIP_PAY_ENABLED',
  'PROACTIVE_SENDS_PAUSED',
];
// Held off by name whether or not the catalog declares it yet, so not asserted in the full output.
const HELD_OFF_ONCE_DECLARED = ['PROACTIVE_WEEKLY_CAP_ENABLED'];

function printedEnv(args) {
  const printed = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  expect(printed.status).toBe(0);
  return Object.fromEntries(
    printed.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

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

describe('--launch-set', () => {
  it('holds promo, payment and pause flags off and forces every other flag as before', () => {
    const full = printedEnv([]);
    const launch = printedEnv(['--launch-set']);
    const expected = { ...full };
    for (const name of HELD_OFF_AT_LAUNCH) {
      expect(full[name]).toBe('true');
      delete expected[name];
    }
    for (const name of HELD_OFF_ONCE_DECLARED) delete expected[name];
    expect(launch).toEqual(expected);
    expect(launch.BROWSER_USE_SIGNUP_PAYMENT_ENABLED).toBe('true');
    expect(launch.LOOP_SEND_ENABLED).toBe('true');
  });

  it('holds off the pause switch, the weekly cap and a payment flag added to the catalog later', () => {
    const boolean = { type: 'boolean', parser: 'exact-true', default: false };
    const { env, unset } = launchSetEnv(
      [
        { ...boolean, key: 'proactive-sends-paused', env: 'PROACTIVE_SENDS_PAUSED' },
        { ...boolean, key: 'proactive-weekly-cap', env: 'PROACTIVE_WEEKLY_CAP_ENABLED' },
        { ...boolean, key: 'loop-send', env: 'LOOP_SEND_ENABLED' },
      ],
      [{ env: 'BROWSER_USE_SIGNUP_PAYMENT_ENABLED' }, { env: 'NEW_PAYMENT_ENABLED' }],
    );
    expect(env).toEqual({ LOOP_SEND_ENABLED: 'true', BROWSER_USE_SIGNUP_PAYMENT_ENABLED: 'true' });
    expect(unset).toEqual([
      'PROACTIVE_SENDS_PAUSED',
      'PROACTIVE_WEEKLY_CAP_ENABLED',
      'NEW_PAYMENT_ENABLED',
    ]);
  });

  it('counts --launch-set only before the -- separator', () => {
    const probe = 'process.stdout.write(process.env.HOLIDAY_PROMO_ENABLED ?? "unset")';
    const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

    const afterSeparator = run(['--', process.execPath, '-e', probe, '--', '--launch-set']);
    expect(afterSeparator.status).toBe(0);
    expect(afterSeparator.stdout).toBe('true');

    const beforeSeparator = run(['--launch-set', '--', process.execPath, '-e', probe]);
    expect(beforeSeparator.status).toBe(0);
    expect(beforeSeparator.stdout).toBe('unset');
  });

  it('removes a held-off flag the caller exported and keeps the rest of the env', () => {
    const read =
      'process.stdout.write(JSON.stringify([process.env.HOLIDAY_PROMO_ENABLED ?? "unset", process.env.PROACTIVE_SENDS_PAUSED ?? "unset", process.env.INHERITED_PROBE, process.env.LOOP_SEND_ENABLED]))';
    const env = {
      ...process.env,
      HOLIDAY_PROMO_ENABLED: 'true',
      PROACTIVE_SENDS_PAUSED: 'true',
      INHERITED_PROBE: 'kept',
    };

    const launch = spawnSync(
      process.execPath,
      [script, '--launch-set', '--', process.execPath, '-e', read],
      { encoding: 'utf8', env },
    );
    expect(launch.status).toBe(0);
    expect(JSON.parse(launch.stdout)).toEqual(['unset', 'unset', 'kept', 'true']);

    const full = spawnSync(process.execPath, [script, '--', process.execPath, '-e', read], {
      encoding: 'utf8',
      env,
    });
    expect(full.status).toBe(0);
    expect(JSON.parse(full.stdout)).toEqual(['true', 'true', 'kept', 'true']);
  });
});

describe('flags-on CI job', () => {
  const workflow = (file) =>
    readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');

  it('runs the launch set past a failed package, advisory, in its own workflow', () => {
    const flagsOn = workflow('flags-on.yml');
    expect(flagsOn.match(/^name: (.+)$/m)[1]).toBe('Flags-on tests');
    expect(flagsOn).toMatch(/group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n/);
    expect(flagsOn).toContain('\npermissions:\n  contents: read\n');
    expect(flagsOn).toContain('name: Unit tests (default-off flags on)');
    expect(flagsOn).toContain('continue-on-error: true');
    expect(flagsOn).toContain(
      'run: node scripts/ci/all-flags-on.mjs --launch-set -- pnpm exec turbo run test --env-mode=loose --force --continue',
    );

    const ci = workflow('ci.yml');
    expect(ci).not.toContain('all-flags-on.mjs');
    const required = ci.slice(ci.indexOf('\n  required:\n'));
    const needs = required.match(/needs: \[(.+)\]/)[1].split(', ');
    expect(needs).toContain('verify');
    expect(needs).not.toContain('flags-on');
  });
});
