import { describe, expect, it } from 'vitest';
import { type PublicCandidateRow, toPublicActivity } from './public.js';

/**
 * The shared public-projection allow-list (rule #1): every unauthenticated share
 * artifact (the /a activity card) projects through `toPublicActivity`, so its
 * closed key set, untrusted-text caps, and sourceUrl scheme validation are the
 * privacy contract. Expected values are derived from the spec (the caps, the
 * http(s)-only rule), never read back from the code.
 */

function familyWideCandidate(overrides: Partial<PublicCandidateRow> = {}): PublicCandidateRow {
  return {
    childId: null,
    title: 'Saturday family swim drop-in',
    kind: 'drop_in',
    summary: 'Parent-and-child swim at the community centre.',
    sourceUrl: 'https://example.org/swim',
    coverageNote: 'serves your area',
    ...overrides,
  };
}

describe('toPublicActivity — the closed allow-list (rule #1)', () => {
  it('exposes ONLY the safe fields: title, kind, summary, sourceUrl, coverageNote, endorsementCount', () => {
    const activity = toPublicActivity(familyWideCandidate());
    expect(Object.keys(activity).sort()).toEqual([
      'coverageNote',
      'endorsementCount',
      'kind',
      'sourceUrl',
      'summary',
      'title',
    ]);
    expect(activity.title).toBe('Saturday family swim drop-in');
    expect(activity.kind).toBe('drop_in');
    // Aggregate count only — defaults to 0 when the loader resolved no counts.
    expect(activity.endorsementCount).toBe(0);
  });

  it('never echoes childId — the projection has no field to carry it', () => {
    const serialized = JSON.stringify(toPublicActivity(familyWideCandidate({ childId: 'child-uuid' })));
    expect(serialized).not.toContain('childId');
    expect(serialized).not.toContain('child-uuid');
  });
});

describe('toPublicActivity — untrusted text/URL hardening (rule #1)', () => {
  it('drops a non-http(s) sourceUrl (javascript:) to null', () => {
    expect(
      toPublicActivity(familyWideCandidate({ sourceUrl: 'javascript:alert(1)' })).sourceUrl,
    ).toBeNull();
  });

  it('drops a data: URL and a relative URL to null', () => {
    expect(
      toPublicActivity(familyWideCandidate({ sourceUrl: 'data:text/html,<script>1</script>' }))
        .sourceUrl,
    ).toBeNull();
    expect(toPublicActivity(familyWideCandidate({ sourceUrl: '/relative/path' })).sourceUrl).toBeNull();
  });

  it('keeps a valid absolute http and https sourceUrl', () => {
    expect(toPublicActivity(familyWideCandidate({ sourceUrl: 'https://ex.com/a' })).sourceUrl).toBe(
      'https://ex.com/a',
    );
    expect(toPublicActivity(familyWideCandidate({ sourceUrl: 'http://ex.com/b' })).sourceUrl).toBe(
      'http://ex.com/b',
    );
  });

  it('truncates title, summary, and coverageNote to their caps', () => {
    const activity = toPublicActivity(
      familyWideCandidate({
        title: 'T'.repeat(500),
        summary: 'S'.repeat(900),
        coverageNote: 'C'.repeat(500),
      }),
    );
    expect(activity.title).toHaveLength(200);
    expect(activity.summary).toHaveLength(600);
    expect(activity.coverageNote).toHaveLength(300);
  });

  it('leaves a null coverageNote null (does not fabricate text)', () => {
    expect(toPublicActivity(familyWideCandidate({ coverageNote: null })).coverageNote).toBeNull();
  });
});
