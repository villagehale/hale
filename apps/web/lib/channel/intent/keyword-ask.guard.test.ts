import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * An instruction to answer with a keyword. Judging Hale's copy, not a parent's
 * message. "reply with a keyword" (a prohibition) does not match.
 */
const KEYWORD_ASK =
  /\b(?:reply|respond with|réponds|reponds|répondez|repondez)\s+(?:yes|no|less|daily|oui|non)\b/i;

/**
 * Flag-off strings still live in these files so today's tests and today's
 * production send the same line. The flag-on path composes over them and does
 * not fall back to them. A new file that asks for a keyword fails this test.
 * Compliance files stay on the list because the law names those words.
 */
const ALLOWED = new Set([
  // Compliance. These words are the carrier's, and the law requires the lines.
  'apps/web/lib/channel/intake/keywords.ts',
  'apps/web/lib/channel/intake/copy.ts',
  'apps/web/lib/channel/off-domain/copy.ts',
  // Flag-off locked corpus. The flag-on path composes over these strings.
  // They stay so today's production send is unchanged while the flag is off.
  'apps/web/lib/channel/checkin/copy.ts',
  'apps/web/lib/channel/router/copy.ts',
  'apps/web/lib/channel/coparent/copy.ts',
  'apps/web/lib/channel/caregiver/copy.ts',
  'apps/web/lib/channel/email/forward-request.ts',
  'apps/web/lib/channel/founder/copy.ts',
]);

function isAsk(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
  if (/\b(?:never|do not|don't|dont|must not)\b/i.test(line)) return false;
  if (/\.(?:includes|test|match)\(/.test(line)) return false;
  return KEYWORD_ASK.test(line);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe('keyword asks', () => {
  it('skills never tell a parent to reply with a keyword', () => {
    const skills = walk(join(REPO, 'packages/agent/skills')).filter((path) => path.endsWith('.md'));
    const hits: string[] = [];
    for (const path of skills) {
      const lines = readFileSync(path, 'utf8').split('\n');
      if (lines.some((line) => isAsk(line))) hits.push(relative(REPO, path));
    }
    expect(hits).toEqual([]);
  });

  it('parent-facing copy outside the compliance and flag-off corpus does not ask for a keyword', () => {
    const roots = [join(REPO, 'apps/web'), join(REPO, 'packages')];
    const hits: string[] = [];
    for (const root of roots) {
      for (const path of walk(root)) {
        if (!path.endsWith('.ts') && !path.endsWith('.tsx') && !path.endsWith('.md')) continue;
        if (path.includes('.test.') || path.includes('.pglite.test.')) continue;
        const rel = relative(REPO, path);
        if (ALLOWED.has(rel)) continue;
        const lines = readFileSync(path, 'utf8').split('\n');
        if (lines.some((line) => isAsk(line))) hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });
});
