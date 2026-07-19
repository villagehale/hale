import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The childcare category string is defined canonically in the web board-filter and
 * hand-mirrored into the mobile api-types (Metro can't import web code). If the two
 * ever drift, the Childcare page's ?category= silently matches nothing and empties.
 * This drift guard reads BOTH files as text and asserts the literal is identical, so
 * a rename fails CI instead of quietly breaking the page.
 */
function readCategoryLiteral(relPath: string): string | null {
  const text = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
  return text.match(/CHILDCARE_RESOURCE_CATEGORY\s*=\s*'([^']+)'/)?.[1] ?? null;
}

describe('childcare category parity (web board-filter ↔ mobile api-types)', () => {
  it('defines the SAME category string in both source files', () => {
    const web = readCategoryLiteral('../village/board-filter.ts');
    const mobile = readCategoryLiteral('../../../mobile/src/lib/api-types.ts');

    // Both must actually define the literal (a rename that drops it fails here too).
    expect(web, 'web board-filter').toBeTruthy();
    expect(mobile, 'mobile api-types').toBeTruthy();
    expect(mobile).toBe(web);
  });
});
