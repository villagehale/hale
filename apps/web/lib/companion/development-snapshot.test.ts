import { companionForChild } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { buildDevelopmentSnapshot } from './development-snapshot.js';

/**
 * The snapshot groups a stage's curated milestones by domain and counts how many
 * are marked done — real data, never a fabricated distribution. The toddler stage
 * (companion.ts) has 5 milestones across motor / language(×2) / social /
 * independence, so its snapshot has FOUR domains (no cognitive milestone at this
 * stage) with language weighted 2. Marking two done is reflected in `done`.
 */
describe('buildDevelopmentSnapshot', () => {
  const NOW = new Date(2026, 5, 15);
  const toddler = (done?: Set<string>) =>
    companionForChild({ dateOfBirth: '2025-01-01', name: 'Ben' }, NOW, {
      milestones: done ?? new Set(),
      health: new Set(),
    }).milestones;

  it('groups by domain, omitting domains with no milestone this stage', () => {
    const snap = buildDevelopmentSnapshot(toddler());
    expect(snap.total).toBe(5);
    expect(snap.done).toBe(0);
    // Toddler stage has no cognitive milestone → cognitive domain is absent.
    expect(snap.domains.map((d) => d.area)).toEqual([
      'language',
      'motor',
      'social',
      'independence',
    ]);
    const language = snap.domains.find((d) => d.area === 'language');
    expect(language?.total).toBe(2);
    expect(language?.label).toBe('Language');
  });

  it('counts milestones marked done, per domain and overall', () => {
    const snap = buildDevelopmentSnapshot(
      toddler(new Set(['Walks independently', 'Says first words'])),
    );
    expect(snap.done).toBe(2);
    expect(snap.domains.find((d) => d.area === 'motor')?.done).toBe(1);
    expect(snap.domains.find((d) => d.area === 'language')?.done).toBe(1);
    expect(snap.domains.find((d) => d.area === 'social')?.done).toBe(0);
  });
});
