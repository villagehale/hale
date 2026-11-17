import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLAGS,
  type FlagSpec,
  PAYMENT_ENV_ONLY,
  POSTHOG_FEATURE_FLAGS_KEY_ENV,
  POSTHOG_FLAGS_ENABLED_ENV,
} from './catalog.js';

/**
 * Barton's rule: flags are read only through packages/flags. A `process.env`
 * read of a catalog flag name outside that package is a direct read. Tests are
 * excluded; they set the env the code under test already reads. The allowlist
 * is today's files and counts. It may only shrink. Raising an allowlist needs
 * Barton's own words.
 */
const ALLOWED: Readonly<Record<string, number>> = {
  'apps/web/lib/channel/coparent/duty/flag.ts': 3,
  'apps/web/lib/channel/f14.ts': 1,
  'apps/web/lib/channel/followup/run.ts': 1,
  'apps/web/lib/channel/linq/group-experience/reading.ts': 1,
  'apps/web/lib/channel/linq/group-experience/voice.ts': 1,
  'apps/web/lib/integrations/booked.ts': 1,
  'apps/web/lib/integrations/team-schedule/apply.ts': 1,
  'apps/web/lib/integrations/team-schedule/flag.ts': 1,
  'apps/web/lib/travel/flag.ts': 1,
  'apps/web/vitest.setup.ts': 1,
  'apps/worker/evals/friend-marks-eval.mjs': 1,
  'apps/worker/evals/name-takeback-eval.mjs': 1,
  'apps/worker/evals/run-coach-capability-correction-eval.mjs': 6,
  'apps/worker/evals/run-household-group-eval.mjs': 1,
  'packages/agent/src/prompt-cache.ts': 1,
};

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'build', '.git']);
const SOURCE = /\.(ts|tsx|mjs|js)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

type Resolved = string | { readonly props: ReadonlyMap<string, string> };

interface Specifier {
  local: string;
  imported: string;
  spec: string;
}

interface ModuleInfo {
  consts: Map<string, string>;
  objects: Map<string, Map<string, string>>;
  imports: Specifier[];
  reexports: Specifier[];
}

function catalogEnvNames(): Set<string> {
  const names = new Set<string>([POSTHOG_FLAGS_ENABLED_ENV, POSTHOG_FEATURE_FLAGS_KEY_ENV]);
  for (const flag of FLAGS as readonly FlagSpec[]) {
    names.add(flag.env);
    if (flag.allowlistEnv) names.add(flag.allowlistEnv);
    if (flag.envAlso) names.add(flag.envAlso.env);
  }
  for (const payment of PAYMENT_ENV_ONLY) names.add(payment.env);
  return names;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => ' '.repeat(block.length))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function specifiers(inner: string, spec: string): Specifier[] {
  const out: Specifier[] = [];
  for (const part of inner.split(',')) {
    const cleaned = part.trim().replace(/^type\s+/, '');
    if (!cleaned) continue;
    const bits = cleaned.split(/\s+as\s+/);
    const imported = bits[0]?.trim() ?? '';
    const local = (bits[1] ?? bits[0])?.trim() ?? '';
    if (!/^[A-Za-z_]/.test(imported) || !/^[A-Za-z_]/.test(local)) continue;
    out.push({ local, imported, spec });
  }
  return out;
}

function parseModule(source: string, envNames: ReadonlySet<string>): ModuleInfo {
  const text = stripComments(source);
  const info: ModuleInfo = {
    consts: new Map(),
    objects: new Map(),
    imports: [],
    reexports: [],
  };
  for (const match of text.matchAll(
    /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([A-Z0-9_]+)['"]/g,
  )) {
    const name = match[1];
    const value = match[2];
    if (name && value && envNames.has(value)) info.consts.set(name, value);
  }
  for (const match of text.matchAll(
    /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{([^{}]*)\}/g,
  )) {
    const name = match[1];
    const body = match[2];
    if (!name || !body) continue;
    const props = new Map<string, string>();
    for (const prop of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*['"]([A-Z0-9_]+)['"]/g)) {
      const key = prop[1];
      const value = prop[2];
      if (key && value && envNames.has(value)) props.set(key, value);
    }
    if (props.size > 0) info.objects.set(name, props);
  }
  for (const match of text.matchAll(
    /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    const inner = match[1];
    const spec = match[2];
    if (inner && spec) info.imports.push(...specifiers(inner, spec));
  }
  for (const match of text.matchAll(/export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    const inner = match[1];
    const spec = match[2];
    if (inner && spec) info.reexports.push(...specifiers(inner, spec));
  }
  return info;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name === 'cache') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const resolvedSpecs = new Map<string, string | undefined>();

function resolveSpec(fromFile: string, spec: string): string | undefined {
  const cacheKey = `${fromFile}\0${spec}`;
  const cached = resolvedSpecs.get(cacheKey);
  if (cached !== undefined || resolvedSpecs.has(cacheKey)) return cached;
  let raw: string | undefined;
  if (spec.startsWith('.')) raw = resolve(dirname(fromFile), spec);
  else if (spec.startsWith('~/')) raw = join(REPO_ROOT, 'apps/web', spec.slice(2));
  else if (spec === '@hale/flags') raw = join(REPO_ROOT, 'packages/flags/src/index.ts');
  let found: string | undefined;
  if (raw) {
    const stripped = raw.replace(/\.(js|ts|tsx|mjs)$/, '');
    const candidates = [
      raw,
      `${stripped}.ts`,
      `${stripped}.tsx`,
      `${stripped}.mjs`,
      `${stripped}.js`,
      join(stripped, 'index.ts'),
    ];
    found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  }
  resolvedSpecs.set(cacheKey, found);
  return found;
}

function lookup(
  modules: ReadonlyMap<string, ModuleInfo>,
  file: string,
  name: string,
  seen = new Set<string>(),
): Resolved | undefined {
  const mark = `${file}::${name}`;
  if (seen.has(mark)) return undefined;
  seen.add(mark);
  const info = modules.get(file);
  if (!info) return undefined;
  const literal = info.consts.get(name);
  if (literal) return literal;
  const object = info.objects.get(name);
  if (object) return { props: object };
  const imported = info.imports.find((item) => item.local === name);
  if (imported) {
    const target = resolveSpec(file, imported.spec);
    if (target) return lookup(modules, target, imported.imported, seen);
  }
  const reexported = info.reexports.find((item) => item.local === name);
  if (reexported) {
    const target = resolveSpec(file, reexported.spec);
    if (target) return lookup(modules, target, reexported.imported, seen);
  }
  return undefined;
}

function countDirectFlagReads(
  source: string,
  envNames: ReadonlySet<string>,
  resolveId: (id: string) => Resolved | undefined,
): number {
  let count = 0;
  for (const line of stripComments(source).split('\n')) {
    for (const match of line.matchAll(/process\.env\??\.([A-Z][A-Z0-9_]*)/g)) {
      const name = match[1];
      if (name && envNames.has(name)) count += 1;
    }
    for (const match of line.matchAll(/process\.env\??\.?\[['"]([A-Z0-9_]+)['"]\]/g)) {
      const name = match[1];
      if (name && envNames.has(name)) count += 1;
    }
    for (const match of line.matchAll(/process\.env\??\.?\[([A-Za-z_][A-Za-z0-9_]*)\]/g)) {
      const id = match[1];
      const resolved = id ? resolveId(id) : undefined;
      if (typeof resolved === 'string' && envNames.has(resolved)) count += 1;
    }
    for (const match of line.matchAll(
      /process\.env\??\.?\[([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\]/g,
    )) {
      const objectName = match[1];
      const prop = match[2];
      const resolved = objectName ? resolveId(objectName) : undefined;
      const env =
        prop && resolved && typeof resolved === 'object' ? resolved.props.get(prop) : undefined;
      if (env && envNames.has(env)) count += 1;
    }
  }
  return count;
}

function mentionsCatalogEnv(text: string, envNames: readonly string[]): boolean {
  for (const name of envNames) {
    if (text.includes(name)) return true;
  }
  return false;
}

function directReads(): Record<string, number> {
  const envNames = catalogEnvNames();
  const envList = [...envNames];
  const files = sourceFiles(REPO_ROOT);
  const texts = new Map<string, string>();
  const modules = new Map<string, ModuleInfo>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    texts.set(file, text);
    if (!text.includes('process.env') && !mentionsCatalogEnv(text, envList)) continue;
    modules.set(file, parseModule(text, envNames));
  }
  const found: Record<string, number> = {};
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (rel.startsWith('packages/flags/') || TEST_FILE.test(file)) continue;
    const text = texts.get(file) ?? '';
    if (!text.includes('process.env')) continue;
    const count = countDirectFlagReads(text, envNames, (id) => lookup(modules, file, id));
    if (count > 0) found[rel] = count;
  }
  return found;
}

describe('catalog flags are not read from process.env', () => {
  // A cold CI runner walks the whole tree. The default 5s test budget has timed this out.
  it('direct reads do not grow past today', () => {
    expect(directReads()).toEqual(ALLOWED);
  }, 20_000);

  it('positive control: a catalog name counts, and another env var does not', () => {
    const names = new Set(['F14_ENABLED', 'CALENDAR_ALERT_ENABLED']);
    const none = () => undefined;
    expect(countDirectFlagReads('process.env.F14_ENABLED', names, none)).toBe(1);
    expect(countDirectFlagReads('process.env.DATABASE_URL', names, none)).toBe(0);
    expect(countDirectFlagReads("process.env['F14_ENABLED']", names, none)).toBe(1);
    expect(countDirectFlagReads('// process.env.F14_ENABLED', names, none)).toBe(0);
    expect(
      countDirectFlagReads('process.env[F14_ENABLED_ENV]', names, (id) =>
        id === 'F14_ENABLED_ENV' ? 'F14_ENABLED' : undefined,
      ),
    ).toBe(1);
    expect(
      countDirectFlagReads('process.env[LANE_ENV.calendar_alert]', names, (id) =>
        id === 'LANE_ENV'
          ? { props: new Map([['calendar_alert', 'CALENDAR_ALERT_ENABLED']]) }
          : undefined,
      ),
    ).toBe(1);
  });
});
