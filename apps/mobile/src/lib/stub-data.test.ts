import { describe, expect, it } from 'vitest';

import { findGuide } from './stub-data';

// The guide ids + titles the prototype's Resources list routes to (`/guide/[id]`).
// Deriving the expectations from the prototype spec — not from GUIDES itself — is what
// makes this catch a broken link: a renamed id or a dropped guide fails here before it
// ships as a dead Resources row.
const EXPECTED: Record<string, string> = {
  sleep: 'Sleep & settling',
  solids: 'Starting solids',
  firstaid: 'First aid basics',
};

describe('findGuide — Resources → Guide page lookup', () => {
  it('resolves every guide the Resources list links to, with its prototype title', () => {
    for (const [id, title] of Object.entries(EXPECTED)) {
      const guide = findGuide(id);
      expect(guide, `guide "${id}" is missing`).toBeDefined();
      expect(guide?.id).toBe(id);
      expect(guide?.title).toBe(title);
      // Editorial contract: an honest read-time and a non-empty numbered tip card.
      expect(guide?.readTime).toMatch(/min read/);
      expect(guide?.tips.length).toBeGreaterThanOrEqual(3);
      expect(guide?.tips.every((tip) => tip.trim().length > 0)).toBe(true);
    }
  });

  it('returns undefined for an unknown id (e.g. a malformed deep link)', () => {
    expect(findGuide('rainy')).toBeUndefined();
    expect(findGuide('')).toBeUndefined();
  });
});
