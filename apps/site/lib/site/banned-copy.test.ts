import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-769: the 11-23 narrative's banned marketing lines must not appear in
 * apps/site. Cited parenting-health articles (lib/answers) are out of this
 * scan: they quote guidance and are not Hale's price or product pitch.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const priceWord = 'fr' + 'ee';

const phrases = [
  'founding ' + 'family',
  'founding ' + 'families',
  'first ' + '100',
  'small and ' + 'early',
  `always ${priceWord}`,
  `${priceWord} for every`,
  `${priceWord} stays ${priceWord}`,
  'helps you ' + 'remember',
  'helps you get ' + 'registered',
  'reminds ' + 'you',
  'remind ' + 'whoever',
  'night ' + 'before',
  'missed ' + 'sign',
  'I’ll send you each the ' + 'link',
  'AI agent you ' + 'text',
  'You ' + 'text Hale',
  'kids' + "' year",
  'kids' + '\u2019 year',
  'spot ' + 'watch',
  'year ' + 'memory',
  'calendar ' + 'invite',
  'spot ' + 'opened',
];

const priceWordPattern = new RegExp(`\\b${priceWord}\\b`, 'i');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|json|css|mjs|md|txt)$/.test(name)) out.push(path);
  }
  return out;
}

function sourceFiles(): string[] {
  return walk(root).filter((path) => {
    const rel = relative(root, path);
    if (rel.startsWith(`lib${'/'}answers${'/'}`)) return false;
    if (rel.startsWith('app/fonts/') && rel.endsWith('-OFL.txt')) return false;
    return true;
  });
}

describe('banned 11-23 marketing lines', () => {
  const files = sourceFiles();

  it('scans the site tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no banned phrase and no price-word pitch', () => {
    const hits: string[] = [];
    for (const path of files) {
      const rel = relative(root, path);
      const text = readFileSync(path, 'utf8');
      for (const phrase of phrases) {
        const at = text.toLowerCase().indexOf(phrase.toLowerCase());
        if (at >= 0) hits.push(`${rel}: ${phrase}`);
      }
      // Prod CSS keeps the .t-free class and comments that name that card.
      // The class token is not the marketing word.
      if (
        !rel.endsWith('.css') &&
        priceWordPattern.test(text.replaceAll('t-free', 't-tier'))
      ) {
        hits.push(`${rel}: ${priceWord}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
