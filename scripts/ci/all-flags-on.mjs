// Force every default-off launch flag on.
//
// Reads packages/flags/src/catalog.ts. Default-on flags are left unset.
// Payment flags are env-only and default off; they are set to exact `true`
// with the rest. A `both` allowlist needs a non-empty list before the flag is
// on for a process-wide read, so that list is set to `forced-on`. A narrow
// allowlist is left empty: an empty list means every family.
//
//   node scripts/ci/all-flags-on.mjs
//   node scripts/ci/all-flags-on.mjs -- pnpm exec turbo run test --env-mode=loose --force

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogPath = path.join(root, 'packages', 'flags', 'src', 'catalog.ts');

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

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

export async function main() {
  rerunWithTypeStripping();
  const { FLAGS, PAYMENT_ENV_ONLY } = await loadCatalog();
  const env = forcedOnEnv(FLAGS, PAYMENT_ENV_ONLY);
  const separator = process.argv.indexOf('--');
  if (separator === -1) {
    process.stdout.write(`${formatEnv(env)}\n`);
    return;
  }
  const command = process.argv.slice(separator + 1);
  if (command.length === 0) {
    console.error('usage: node scripts/ci/all-flags-on.mjs -- <command> [args]');
    process.exit(2);
  }
  try {
    const code = await runCommand(command[0], command.slice(1), env);
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
