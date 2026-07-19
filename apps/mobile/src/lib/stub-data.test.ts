import { describe, expect, it } from 'vitest';

import { findGuide, findSampleThread } from './stub-data';

// The guide ids + titles the prototype's Resources list routes to (`/guide/[id]`).
// Deriving the expectations from the prototype spec — not from GUIDES itself — is what
// makes this catch a broken link: a renamed id or a dropped guide fails here before it
// ships as a dead Resources row.
const EXPECTED: Record<string, string> = {
  sleep: 'Sleep & settling',
  solids: 'Starting solids',
  firstaid: 'First aid basics',
};

// The onboarding intent each guide is tagged with — the key the Resources list floats
// on for a family that stated it. Spec-derived (not read from GUIDES) so a mis-tag that
// would silently break the reorder fails here.
const EXPECTED_INTENT: Record<string, string> = {
  sleep: 'sleep',
  solids: 'feeding',
  firstaid: 'health',
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
      // Intent tag drives the Resources reorder — must match the spec mapping.
      expect(guide?.intent).toBe(EXPECTED_INTENT[id]);
    }
  });

  it('returns undefined for an unknown id (e.g. a malformed deep link)', () => {
    expect(findGuide('rainy')).toBeUndefined();
    expect(findGuide('')).toBeUndefined();
  });
});

// The three demo conversations the prototype's Messages "Sample" section routes to
// (`/thread/[id]`). Expectations come from the prototype spec — not from SAMPLE_THREADS
// itself — so a renamed id, a dropped thread, or a real-id collision fails here.
const EXPECTED_THREADS = {
  'sample-daycare': { name: 'Little Steps Daycare', hasQuickActions: true },
  'sample-sarah': { name: 'Sarah', hasQuickActions: false },
  'sample-peds': { name: 'Georgetown Pediatrics', hasQuickActions: false },
} as const;

describe('findSampleThread — Messages → sample Thread lookup', () => {
  it('resolves every sample thread the Messages list links to, with its prototype sender', () => {
    for (const [id, expected] of Object.entries(EXPECTED_THREADS)) {
      const thread = findSampleThread(id);
      expect(thread, `sample thread "${id}" is missing`).toBeDefined();
      expect(thread?.id).toBe(id);
      expect(thread?.name).toBe(expected.name);
      // Quick actions are the prototype's daycare-only View details / Add to calendar.
      expect((thread?.quickActions.length ?? 0) > 0).toBe(expected.hasQuickActions);
      // A conversation must open on an incoming message (someone messaged the parent).
      expect(thread?.rows[0]?.from).toBe('them');
      expect(thread?.rows.every((row) => row.text.trim().length > 0)).toBe(true);
    }
  });

  it('never resolves a REAL message id — the sample and Hale-feed lanes stay separate', () => {
    // Real ids are `digest-…` / `action-…` (web mappers). Resolving one here would blend
    // the lanes and open a live note as a fabricated conversation.
    expect(findSampleThread('action-a1')).toBeUndefined();
    expect(findSampleThread('digest-d1')).toBeUndefined();
    expect(findSampleThread('daycare')).toBeUndefined();
    expect(findSampleThread('')).toBeUndefined();
  });
});
