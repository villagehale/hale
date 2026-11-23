import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  ACTION_CLASSES_BY_KIND,
  ASK_TIERS,
  ASK_TIER_BY_CLASS,
  actionClassesFor,
  askTierFor,
  isAskPolicyKind,
} from './index.js';

/**
 * VIL-719 · docs/ask-policy.md is the table people review and later work follows. This holds
 * its two tables to the code: change one and this fails until the other matches. The doc is
 * read as text with plain string operations.
 */

const DOC = readFileSync(
  fileURLToPath(new URL('../../../docs/ask-policy.md', import.meta.url)),
  'utf8',
);

function section(heading: string): string[] {
  const lines = DOC.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`docs/ask-policy.md has no "${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The cells of every table row in a section whose first cell is a code span. */
function rows(heading: string): string[][] {
  return section(heading)
    .filter((line) => line.startsWith('| `'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

/** `a`, `b` -> ['a', 'b'] */
function codeSpans(cell: string): string[] {
  return cell
    .split(',')
    .map((part) => part.trim().split('`').join(''))
    .filter((part) => part.length > 0);
}

describe('docs/ask-policy.md', () => {
  it('names the three tiers, in order', () => {
    expect(rows('## The three tiers').map((row) => codeSpans(row[0] ?? '')[0])).toEqual([
      ...ASK_TIERS,
    ]);
  });

  it('gives every class the tier the code gives it, once each', () => {
    const table = rows('## Classes and their tiers');
    const documented = table.map((row) => codeSpans(row[0] ?? '')[0]);
    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual([...ACTION_CLASSES].sort());
    for (const row of table) {
      const [actionClass] = codeSpans(row[0] ?? '');
      const [tier] = codeSpans(row[1] ?? '');
      expect({ actionClass, tier }).toEqual({
        actionClass,
        tier: ASK_TIER_BY_CLASS[actionClass as keyof typeof ASK_TIER_BY_CLASS],
      });
    }
  });

  it('lists every action kind once, with the classes and tier the code gives it', () => {
    const table = rows('## Every action kind');
    const documented = table.map((row) => codeSpans(row[0] ?? '')[0] ?? '');
    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual(Object.keys(ACTION_CLASSES_BY_KIND).sort());
    for (const row of table) {
      const [kind = ''] = codeSpans(row[0] ?? '');
      expect(isAskPolicyKind(kind)).toBe(true);
      if (!isAskPolicyKind(kind)) continue;
      expect({ kind, classes: codeSpans(row[1] ?? '').sort() }).toEqual({
        kind,
        classes: actionClassesFor(kind).sort(),
      });
      expect({ kind, tier: codeSpans(row[2] ?? '')[0] }).toEqual({ kind, tier: askTierFor(kind) });
    }
  });
});
