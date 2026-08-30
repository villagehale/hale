import { describe, expect, it } from 'vitest';
import { skillsInventory } from './skills-inventory';

describe('skillsInventory', () => {
  it('reads the real lock file: every row has a name and a 64-hex sha', () => {
    const rows = skillsInventory();
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      expect(row.name).not.toMatch(/\.md$/);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.shaShort).toBe(row.sha256.slice(0, 12));
    }
    // Sorted, so the table is stable across lock rewrites.
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
