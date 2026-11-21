// Force every default-off launch flag on.
//
// Reads packages/flags/src/catalog.ts. Default-on flags are left unset.
// Payment flags are env-only and default off; they are set to exact `true`
// with the rest. A `both` allowlist (memory digest) is on for a named family
// only when that family's id is listed. The suite creates those ids while it
// runs, so the list is the sentinel `forced-on`: the process-wide read turns
// on, and a family-scoped read stays off unless the id is that sentinel. A
// narrow allowlist is left empty, which means every family.
//
// --launch-set forces every default-off catalog flag except promo, payment (all but
// LAUNCH_PAYMENT_ENV), the proactive pause switch and the weekly proactive cap.
//
//   node scripts/ci/all-flags-on.mjs
//   node scripts/ci/all-flags-on.mjs -- pnpm exec turbo run test --env-mode=loose --force
//   node scripts/ci/all-flags-on.mjs --launch-set -- pnpm exec turbo run test --env-mode=loose --force --continue

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogPath = path.join(root, 'packages', 'flags', 'src', 'catalog.ts');
const LAUNCH_PAYMENT_ENV = new Set(['BROWSER_USE_SIGNUP_PAYMENT_ENABLED']);
// PROACTIVE_SENDS_PAUSED refuses every proactive send when on, so no launch state has it on.
// PROACTIVE_WEEKLY_CAP_ENABLED stays off until Barton says go; it has no catalog row yet.
const LAUNCH_HELD_OFF_ENV = new Set(['PROACTIVE_SENDS_PAUSED', 'PROACTIVE_WEEKLY_CAP_ENABLED']);

/**
 * @param {{ type?: string, parser?: string, default?: boolean | string, onVariant?: string }} spec
 */
export function isDefaultOff(spec) {
  if (spec.type === 'multivariate' || spec.parser === 'multivariate') {
    return spec.onVariant !== undefined && spec.default !== spec.onVariant;
  }
  return spec.default === false;
}

/**
 * @param {{ key?: string, env?: string, type?: string, parser?: string, onVariant?: string }} spec
 */
export function onValue(spec) {
  if (spec.type === 'multivariate' || spec.parser === 'multivariate') {
    if (typeof spec.onVariant !== 'string' || spec.onVariant.length === 0) {
      throw new Error(`${spec.key ?? spec.env} has no on variant`);
    }
    return spec.onVariant;
  }
  switch (spec.parser) {
    case 'trimmed-on':
    case 'exact-on':
    case 'trimmed-not-off':
      return 'on';
    case 'inverted-disabled':
      return 'false';
    case 'exact-true':
    case 'trimmed-true':
    case 'not-exact-false':
    case 'trimmed-not-false':
      return 'true';
    default:
      throw new Error(`${spec.env} has no on value for parser ${spec.parser}`);
  }
}

/**
 * @param {readonly { env: string, type?: string, parser?: string, default?: boolean | string, onVariant?: string, allowlistMode?: string, allowlistEnv?: string, envAlso?: { env: string, value: string }, key?: string }[]} flags
 * @param {readonly { env: string }[]} [paymentEnvOnly]
 * @returns {Record<string, string>}
 */
export function forcedOnEnv(flags, paymentEnvOnly = []) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const spec of flags) {
    if (!isDefaultOff(spec)) continue;
    env[spec.env] = onValue(spec);
    if (spec.allowlistMode === 'both' && spec.allowlistEnv) {
      env[spec.allowlistEnv] = 'forced-on';
    }
    if (spec.envAlso) env[spec.envAlso.env] = spec.envAlso.value;
  }
  for (const row of paymentEnvOnly) env[row.env] = 'true';
  return env;
}

/**
 * The env for a launch-set run, plus the flags it holds off, to remove so a value
 * exported in the caller's shell cannot turn one back on.
 *
 * @param {Parameters<typeof forcedOnEnv>[0]} flags
 * @param {readonly { env: string }[]} paymentEnvOnly
 * @returns {{ env: Record<string, string>, unset: string[] }}
 */
export function launchSetEnv(flags, paymentEnvOnly) {
  const isLaunchPayment = (row) => LAUNCH_PAYMENT_ENV.has(row.env);
  const isHeldOff = (spec) => LAUNCH_HELD_OFF_ENV.has(spec.env);
  return {
    env: forcedOnEnv(
      flags.filter((spec) => !isHeldOff(spec)),
      paymentEnvOnly.filter(isLaunchPayment),
    ),
    unset: [
      ...flags.filter(isHeldOff),
      ...paymentEnvOnly.filter((row) => !isLaunchPayment(row)),
    ].map((row) => row.env),
  };
}

/**
 * @param {Record<string, string>} env
 */
export function formatEnv(env) {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join('\n');
}

function rerunWithTypeStripping() {
  const mode = process.features?.typescript;
  if (mode === 'strip' || mode === 'transform') return;
  if (process.execArgv.includes('--experimental-strip-types')) return;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: process.env },
  );
  process.exit(result.status ?? 1);
}

async function loadCatalog() {
  return import(pathToFileURL(catalogPath).href);
}

function runCommand(command, args, env, unset) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    for (const name of unset) delete childEnv[name];
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: childEnv,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

export async function main() {
  rerunWithTypeStripping();
  const { FLAGS, PAYMENT_ENV_ONLY } = await loadCatalog();
  const separator = process.argv.indexOf('--');
  const launchSet = process.argv
    .slice(2, separator === -1 ? undefined : separator)
    .includes('--launch-set');
  const { env, unset } = launchSet
    ? launchSetEnv(FLAGS, PAYMENT_ENV_ONLY)
    : { env: forcedOnEnv(FLAGS, PAYMENT_ENV_ONLY), unset: [] };
  if (separator === -1) {
    process.stdout.write(`${formatEnv(env)}\n`);
    return;
  }
  const command = process.argv.slice(separator + 1);
  if (command.length === 0) {
    console.error('usage: node scripts/ci/all-flags-on.mjs [--launch-set] -- <command> [args]');
    process.exit(2);
  }
  try {
    const code = await runCommand(command[0], command.slice(1), env, unset);
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
