import { describe, expect, it, vi } from 'vitest';

/**
 * Rule #1 teen redaction, refined by the parent-authored exemption (policy 2):
 *
 *  - A 13+ child's OWN content — an episode that arrived via the inbound pipeline
 *    (authoredBy === null) and is attributed to the teen — must NOT surface to a
 *    parent. Derived LIVE from each child's DOB (deriveStage boundary 156mo).
 *  - A parent's OWN log ABOUT their teen is the PARENT's content, not the teen's,
 *    so it is EXEMPT and survives for its author (authoredBy === requestingUserId).
 *    Quick-logs are the only writer of this table today, so they are all
 *    parent-authored and must never be silently dropped from their author.
 *  - An UNATTRIBUTED episode (childId null) the requesting parent authored is
 *    likewise their own note — kept. Only a NON-authored unattributed row (no DOB
 *    to derive from, not the requester's) falls to the family "most restrictive"
 *    default and drops when the family has a teen.
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
const PARENT_ID = 'parent-1';
const OTHER_PARENT_ID = 'parent-2';

const CHILDREN = [
  { id: TEEN_ID, dateOfBirth: '2011-01-01' }, // ~15y → teenager
  { id: TODDLER_ID, dateOfBirth: '2024-05-01' }, // ~25mo → toddler
];

const TEEN_OWN_SUMMARY = 'Maya said she is anxious about the dance';
const PARENT_ABOUT_TEEN_SUMMARY = 'took Maya to the orthodontist';
const TODDLER_SUMMARY = 'Mara napped 90 minutes';
const FAMILY_NOTE_SUMMARY = 'family movie night';

interface TestEpisode {
  id: string;
  childId: string | null;
  authoredBy: string | null;
  episodeType: string;
  summary: string;
  occurredAt: Date;
}

function ep(over: Partial<TestEpisode>): TestEpisode {
  return {
    id: 'e',
    childId: null,
    authoredBy: null,
    episodeType: 'note',
    summary: 's',
    occurredAt: NOW,
    ...over,
  };
}

describe('recent-logs teen redaction (_internal.dropTeenEpisodes)', () => {
  it("drops the teen's OWN (pipeline-authored) content but KEEPS the parent's own log about the teen", () => {
    const episodes = [
      ep({ id: 'e1', childId: TEEN_ID, authoredBy: null, summary: TEEN_OWN_SUMMARY }),
      ep({ id: 'e2', childId: TEEN_ID, authoredBy: PARENT_ID, summary: PARENT_ABOUT_TEEN_SUMMARY }),
      ep({ id: 'e3', childId: TODDLER_ID, authoredBy: PARENT_ID, summary: TODDLER_SUMMARY }),
    ];
    const kept = _internal.dropTeenEpisodes(episodes, CHILDREN, PARENT_ID, NOW);
    const summaries = kept.map((e) => e.summary);
    // Policy 2: the parent's own log about their teen survives for its author.
    expect(summaries).toContain(PARENT_ABOUT_TEEN_SUMMARY);
    expect(summaries).toContain(TODDLER_SUMMARY);
    // The teen's own pipeline-authored content is still dropped.
    expect(summaries).not.toContain(TEEN_OWN_SUMMARY);
    expect(JSON.stringify(kept)).not.toContain(TEEN_OWN_SUMMARY);
  });

  it("keeps the requesting parent's own UNATTRIBUTED note even when the family has a teen (no blanket drop)", () => {
    const episodes = [
      ep({ id: 'e1', childId: null, authoredBy: PARENT_ID, summary: FAMILY_NOTE_SUMMARY }),
    ];
    const kept = _internal.dropTeenEpisodes(episodes, CHILDREN, PARENT_ID, NOW);
    expect(kept.map((e) => e.summary)).toContain(FAMILY_NOTE_SUMMARY);
  });

  it("drops a NON-requester, unattributed row for a teen family (most-restrictive fallback)", () => {
    // authored by the co-parent, unattributed, no DOB to derive from → the family
    // fallback applies for THIS requester: it could quote the teen.
    const episodes = [
      ep({ id: 'e1', childId: null, authoredBy: OTHER_PARENT_ID, summary: FAMILY_NOTE_SUMMARY }),
    ];
    const kept = _internal.dropTeenEpisodes(episodes, CHILDREN, PARENT_ID, NOW);
    expect(kept.map((e) => e.summary)).not.toContain(FAMILY_NOTE_SUMMARY);
  });

  it('keeps every row when the family has no teenager', () => {
    const noTeenFamily = [{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }];
    const episodes = [
      ep({ id: 'e1', childId: null, authoredBy: OTHER_PARENT_ID, summary: FAMILY_NOTE_SUMMARY }),
      ep({ id: 'e2', childId: TODDLER_ID, authoredBy: PARENT_ID, summary: TODDLER_SUMMARY }),
    ];
    const kept = _internal.dropTeenEpisodes(episodes, noTeenFamily, PARENT_ID, NOW);
    expect(kept).toHaveLength(episodes.length);
    expect(kept.map((e) => e.summary)).toContain(FAMILY_NOTE_SUMMARY);
  });
});
