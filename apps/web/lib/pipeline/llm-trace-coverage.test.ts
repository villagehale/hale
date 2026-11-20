import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every Anthropic construction must go through the tracing wrapper. A new
 * `new Anthropic(` in production that is not `traceAnthropic(new Anthropic(` (the
 * two factories) or a new eval construction that is not `wrapEvalAnthropic(new
 * Anthropic(` is a silent analytics hole: that call site would never emit
 * `$ai_generation`. This test fails the moment either happens.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const RAW = 'new Anthropic(';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'cache']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;

const PRODUCTION_FACTORIES = new Set([
  'apps/web/lib/pipeline/client.ts',
  'apps/worker/src/anthropic/client.ts',
]);

const PRODUCTION_ROOTS = [
  'apps/web/app',
  'apps/web/lib',
  'apps/web/components',
  'apps/web/scripts',
  'apps/worker/src',
  'apps/worker/scripts',
  'packages',
];

function sourceFiles(dir: string, includeTests: boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full, includeTests));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (!includeTests && (name.includes('.test.') || name.endsWith('.d.ts'))) continue;
    out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return file.slice(REPO_ROOT.length + 1);
}

function indicesOf(src: string, token: string): number[] {
  const found: number[] = [];
  let from = 0;
  while (from < src.length) {
    const at = src.indexOf(token, from);
    if (at === -1) break;
    found.push(at);
    from = at + token.length;
  }
  return found;
}

function precedingCall(src: string, index: number, name: string): boolean {
  const before = src.slice(Math.max(0, index - 80), index).replace(/\s+/g, ' ');
  return before.trimEnd().endsWith(`${name}(`);
}

function windowHasStage(src: string, index: number): boolean {
  const window = src.slice(index, index + 280);
  const end = window.search(/\)\s*;/);
  const body = end === -1 ? window : window.slice(0, end);
  return /(?:^|[,{\s])stage\s*:/.test(body);
}

describe('every Anthropic call site goes through the tracing wrapper', () => {
  it('production `new Anthropic(` lives only in the two factories, each wrapped by traceAnthropic', () => {
    const strangers: string[] = [];
    const unwrapped: string[] = [];
    for (const root of PRODUCTION_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root), false)) {
        const src = readFileSync(file, 'utf8');
        const hits = indicesOf(src, RAW);
        if (hits.length === 0) continue;
        const path = rel(file);
        if (!PRODUCTION_FACTORIES.has(path)) {
          strangers.push(`${path} (${hits.length})`);
          continue;
        }
        const wraps = src.match(/traceAnthropic\(/g)?.length ?? 0;
        if (wraps < hits.length) {
          unwrapped.push(`${path} (wraps ${wraps} < constructions ${hits.length})`);
        }
      }
    }
    expect(strangers, `new Anthropic( outside the factories:\n  ${strangers.join('\n  ')}`).toEqual(
      [],
    );
    expect(
      unwrapped,
      `factory construction not handed to traceAnthropic:\n  ${unwrapped.join('\n  ')}`,
    ).toEqual([]);
  });

  it('eval `new Anthropic(` is always wrapEvalAnthropic(new Anthropic(', () => {
    const evalRoot = join(REPO_ROOT, 'apps/worker/evals');
    const unwrapped: string[] = [];
    for (const file of sourceFiles(evalRoot, true)) {
      const src = readFileSync(file, 'utf8');
      const hits = indicesOf(src, RAW);
      if (hits.length === 0) continue;
      for (const at of hits) {
        if (!precedingCall(src, at, 'wrapEvalAnthropic')) {
          unwrapped.push(`${rel(file)} @${at}`);
        }
      }
    }
    expect(
      unwrapped,
      `eval constructions that bypass wrapEvalAnthropic — they will never emit $ai_generation:\n  ${unwrapped.join('\n  ')}`,
    ).toEqual([]);
  });

  it('production budgetedAnthropic( / anthropicClient( call sites label a hale_stage', () => {
    const unlabeled: string[] = [];
    for (const root of PRODUCTION_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root), false)) {
        const src = readFileSync(file, 'utf8');
        const path = rel(file);
        for (const token of ['budgetedAnthropic(', 'budgetedAiGateway('] as const) {
          for (const at of indicesOf(src, token)) {
            const before = src.slice(Math.max(0, at - 24), at);
            if (/function\s+$/.test(before)) continue;
            if (!windowHasStage(src, at)) unlabeled.push(`${path} ${token}`);
          }
        }
      }
    }
    expect(
      unlabeled,
      `call sites with no stage: label — they land in hale_stage=unattributed:\n  ${unlabeled.join('\n  ')}`,
    ).toEqual([]);
  });
});
