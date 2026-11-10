import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flushPosthog,
  productClient,
  projectClient,
  projectTracingEnabled,
  resetPosthogClientsForTests,
} from './posthog-node';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPosthogClientsForTests();
});

describe('no key, no client', () => {
  it('builds nothing and touches no network when both keys are unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', '');
    resetPosthogClientsForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(productClient()).toBeNull();
    expect(projectClient()).toBeNull();
    expect(projectTracingEnabled()).toBe(false);
    await flushPosthog();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the product key alone does NOT turn on tracing or error tracking', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_product');
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', '');
    resetPosthogClientsForTests();
    expect(productClient()).not.toBeNull();
    expect(projectClient()).toBeNull();
  });
});

// Source-structure guard (not content matching): every server PostHog client is built
// in posthog-node.ts, and every OpenAI client — there are none today — would have to go
// through the same traced factory as Anthropic (lib/pipeline/client.ts).
const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIP = new Set(['node_modules', '.next', '.turbo', 'dist', 'coverage']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('one factory per client', () => {
  const files = sourceFiles(WEB_ROOT).map((f) => ({
    rel: relative(WEB_ROOT, f),
    src: readFileSync(f, 'utf8'),
  }));

  it('positive control: the scan sees the factory itself', () => {
    expect(files.some((f) => f.rel === 'lib/analytics/posthog-node.ts')).toBe(true);
  });

  it('constructs posthog-node only in lib/analytics/posthog-node.ts', () => {
    const offenders = files
      .filter((f) => f.src.includes('new PostHog('))
      .map((f) => f.rel)
      .filter((rel) => rel !== 'lib/analytics/posthog-node.ts');
    expect(offenders).toEqual([]);
  });

  it('constructs no raw OpenAI client anywhere (none exists; one must go through the traced factory)', () => {
    const offenders = files.filter((f) => f.src.includes('new OpenAI(')).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe('every Anthropic factory is traced', () => {
  // `new Anthropic(` may only appear in these two files (no-raw-anthropic.test.ts), so
  // checking that each construction there is handed straight to traceAnthropic covers
  // every model call in web and worker.
  const factories = [
    join(WEB_ROOT, 'lib/pipeline/client.ts'),
    join(WEB_ROOT, '../worker/src/anthropic/client.ts'),
  ];
  for (const path of factories) {
    it(`${relative(join(WEB_ROOT, '..'), path)} wraps what it constructs`, () => {
      const src = readFileSync(path, 'utf8');
      const constructions = src.split('new Anthropic(').length - 1;
      expect(constructions).toBeGreaterThan(0);
      expect(src.match(/traceAnthropic\(/g)?.length ?? 0).toBeGreaterThanOrEqual(constructions);
    });
  }
});
