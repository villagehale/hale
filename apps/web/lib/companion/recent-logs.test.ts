import { describe, expect, it, vi } from 'vitest';

/**
 * Rule #1: a 13+ child's quick-log episode summary must NOT surface to a parent on
 * the companion recent-logs list, even when the episode carries no teen flag (the
 * episodes table has none — it leaks regardless). The teen set is derived LIVE from
 * each child's DOB (deriveStage boundary 156mo), mirroring search_memory; an episode
 * attributed to a teen child is dropped from the list outright.
 *
 * Double-miss (rule #1 "most restrictive"): an UNATTRIBUTED episode (childId null) is
 * ALSO dropped when the family has any teenager — a family-wide quick-log could quote
 * the teen and there is no DOB to derive from. A family with no teen keeps it (no
 * over-redaction).
 */

// recent-logs.ts imports the server-only auth chain for its request wrapper; mock
// it (as feed.test.ts does) so the pure _internal helper is importable here.
vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/db', () => ({ db: vi.fn() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn() }));

const { _internal } = await import('./recent-logs.js');

const NOW = new Date('2026-06-21T12:00:00Z');
const TEEN_ID = 'teen-1';
const TODDLER_ID = 'tot-1';

const CHILDREN = [
  { id: TEEN_ID, dateOfBirth: '2011-01-01' }, // ~15y → teenager
  { id: TODDLER_ID, dateOfBirth: '2024-05-01' }, // ~25mo → toddler
];

const TEEN_SUMMARY = 'Maya said she is anxious about the dance';
const TODDLER_SUMMARY = 'Mara napped 90 minutes';
const FAMILY_SUMMARY = 'Family movie night';

const EPISODES = [
  { id: 'e1', childId: TEEN_ID, episodeType: 'mood', summary: TEEN_SUMMARY, occurredAt: NOW },
  { id: 'e2', childId: TODDLER_ID, episodeType: 'sleep', summary: TODDLER_SUMMARY, occurredAt: NOW },
  { id: 'e3', childId: null, episodeType: 'note', summary: FAMILY_SUMMARY, occurredAt: NOW },
];

describe('recent-logs teen redaction (_internal.dropTeenEpisodes)', () => {
  it('drops a teen child episode AND the unattributed family-wide episode while keeping non-teen rows (family has a teen)', () => {
    const kept = _internal.dropTeenEpisodes(EPISODES, CHILDREN, NOW);
    const summaries = kept.map((e) => e.summary);
    expect(summaries).not.toContain(TEEN_SUMMARY);
    // Double-miss: an unattributed episode is dropped when the family has a teen.
    expect(summaries).not.toContain(FAMILY_SUMMARY);
    expect(summaries).toContain(TODDLER_SUMMARY);
    expect(JSON.stringify(kept)).not.toContain(TEEN_SUMMARY);
  });

  it('keeps every row (including the unattributed one) when the family has no teenager', () => {
    const noTeenFamily = [{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }];
    const kept = _internal.dropTeenEpisodes(EPISODES, noTeenFamily, NOW);
    expect(kept).toHaveLength(EPISODES.length);
    expect(kept.map((e) => e.summary)).toContain(FAMILY_SUMMARY);
  });
});
