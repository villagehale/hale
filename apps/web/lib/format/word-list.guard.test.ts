import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Barton's rule: no regex or word-list intent detection. An English word-list
 * regex is an alternation of plain words inside word boundaries, the shape of
 * `/\b(yes|no|stop)\b/i`, in a regex literal or a RegExp string. This file
 * counts them across apps and packages source, tests excluded. The allowlist
 * is today's files and counts. It may only shrink. Raising an allowlist needs
 * Barton's own words.
 */
const ALLOWED: Readonly<Record<string, number>> = {
  'apps/web/lib/channel/consent-ask.ts': 1,
  'apps/web/lib/channel/coparent/duty/cadence.ts': 1,
  'apps/web/lib/channel/coparent/duty/extract.ts': 1,
  'apps/web/lib/channel/coparent/duty/parse.ts': 2,
  'apps/web/lib/channel/intake/cold-start/ladder.ts': 1,
  'apps/web/lib/channel/intake/friend-voice.ts': 6,
  'apps/web/lib/channel/rec-morning/match.ts': 1,
  'apps/web/lib/channel/reconcile/claims.ts': 2,
  'apps/web/lib/channel/referral/share.ts': 1,
  'apps/web/lib/channel/stated-state.ts': 4,
  'apps/web/lib/coach/action-intent.ts': 1,
  'apps/web/lib/coach/topic.ts': 1,
  'apps/web/lib/party/reply.ts': 1,
  'apps/web/lib/passport/signals.ts': 3,
  'apps/web/lib/signup/plan/reader.ts': 1,
  'apps/web/lib/testing/onboarding-live-rules.ts': 1,
  'apps/web/lib/village/intros/voice.ts': 1,
  'apps/worker/evals/borrowed-find-dates.mjs': 2,
  'apps/worker/evals/calendar-cancel-voice-fixtures.mjs': 1,
  'apps/worker/evals/calendar-kid-notice-fixtures.mjs': 1,
  'apps/worker/evals/coach-channel-menu-gate.mjs': 1,
  'apps/worker/evals/followup-voice-fixtures.mjs': 2,
  'apps/worker/evals/identity-ask-fixtures.mjs': 1,
  'apps/worker/evals/run-coach-channel-eval.mjs': 1,
  'apps/worker/evals/run-coach-plan-eval.mjs': 1,
  'apps/worker/evals/run-intro-voice-eval.mjs': 1,
};

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'build']);
const SOURCE = /\.(ts|tsx|mjs|js)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** `\b(yes|no|stop)\b` in a regex literal, or the same bytes escaped in a string. */
const WORD_LIST = /\\{1,2}b\((?:\?:)?[A-Za-z]{2,}(?:\|[A-Za-z]{2,})+\)\\{1,2}b/g;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => ' '.repeat(block.length))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function countWordLists(source: string): number {
  return [...stripComments(source).matchAll(WORD_LIST)].length;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE.test(name) || TEST_FILE.test(name) || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function wordListCounts(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const root of ['apps', 'packages']) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      const count = countWordLists(readFileSync(file, 'utf8'));
      if (count > 0) found[relative(REPO_ROOT, file)] = count;
    }
  }
  return found;
}

describe('English word-list regexes', () => {
  it('do not grow past today', () => {
    expect(wordListCounts()).toEqual(ALLOWED);
  });

  it('positive control: the scan sees a word-list regex and ignores a plain alternation', () => {
    expect(countWordLists('const STOP = /\\b(yes|no|stop)\\b/i;')).toBe(1);
    expect(countWordLists('new RegExp("\\\\b(?:yes|no)\\\\b", "i")')).toBe(1);
    expect(countWordLists('const n = /(yes|no)/;')).toBe(0);
    expect(countWordLists('const n = /\\b(a|b)\\b/;')).toBe(0);
    expect(countWordLists('const n = /\\b(https?:\\/\\/|www)\\b/;')).toBe(0);
  });
});
