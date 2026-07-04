import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '../dashboard/mappers.js';
import {
  type RoutineProposal,
  type VillageCandidate,
  filterCandidatesByCadence,
  filterCandidatesByScope,
  toRoutineProposalView,
  toVillageCandidateView,
} from './mappers.js';

const RAW_TITLE = 'Riverdale teen LGBTQ+ peer support drop-in';
const RAW_SUMMARY = 'Confidential weekly group for your 15-year-old at the community centre.';
const RAW_COVERAGE = 'serves the east-end neighbourhoods';
const RAW_SOURCE_URL = 'https://example.org/riverdale-teen-group';

function candidate(overrides: Partial<VillageCandidate> = {}): VillageCandidate {
  return {
    id: 'cand-1',
    familyId: 'fam-1',
    childId: 'child-teen',
    title: RAW_TITLE,
    kind: 'support_group',
    cadence: 'ongoing',
    summary: RAW_SUMMARY,
    sourceUrl: RAW_SOURCE_URL,
    source: 'web_grounded',
    confidence: 0.9,
    coverageNote: RAW_COVERAGE,
    lat: 43.6777,
    lng: -79.3534,
    venueName: 'Riverdale Community Centre',
    venueAddress: '123 Broadview Ave, Toronto, ON',
    shareToken: null,
    eventDate: null,
    seasons: null,
    supersededAt: null,
    discoveredAt: new Date('2026-06-11T10:00:00Z'),
    ...overrides,
  };
}

const NO_ENGAGEMENT = { endorsementCount: 0, endorsedByFamily: false, accepted: false };

function proposal(overrides: Partial<RoutineProposal> = {}): RoutineProposal {
  return {
    id: 'prop-1',
    familyId: 'fam-1',
    weekOf: '2026-06-15',
    items: [],
    shareToken: null,
    createdAt: new Date('2026-06-11T10:00:00Z'),
    ...overrides,
  };
}

describe('toVillageCandidateView', () => {
  it('marks teen-attributed, surfaces only the category, and never duplicates the redaction line', () => {
    const view = toVillageCandidateView(candidate(), true, NO_ENGAGEMENT);

    // Rule #1: only the category survives. The title carries the one redaction
    // line; summary is empty so the renderer states the why exactly once.
    expect(view.teenAttributed).toBe(true);
    // The child attribution (an opaque id, never a name) is kept so the scope
    // filter can still narrow to this child — the name is withheld at the chip.
    expect(view.childId).toBe('child-teen');
    expect(view.title).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.summary).toBe('');
    expect(view.coverageNote).toBeNull();
    expect(view.sourceUrl).toBeNull();
    expect(view.kind).toBe('support_group');
    // Cadence AND seasons are dropped on a teen card so no per-child recurrence
    // signal leaks; the run-recency stamp (not raw content) survives.
    expect(view.cadence).toBeNull();
    expect(view.seasons).toBeNull();
    expect(view.discoveredAt).toBe('2026-06-11T10:00:00.000Z');
    // Rule #1: a teen-attributed candidate is never plottable — coords drop to
    // null so the map can never surface a teen's activity location.
    expect(view.lat).toBeNull();
    expect(view.lng).toBeNull();
    expect(view.venueName).toBeNull();

    // Structural guarantee: no raw discovered text reaches the view at all.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(RAW_TITLE);
    expect(serialized).not.toContain(RAW_SUMMARY);
    expect(serialized).not.toContain(RAW_COVERAGE);
    expect(serialized).not.toContain(RAW_SOURCE_URL);
  });

  it('passes every raw field through unchanged and unmarked when NOT teen-attributed', () => {
    const view = toVillageCandidateView(candidate(), false, NO_ENGAGEMENT);

    expect(view.teenAttributed).toBe(false);
    expect(view.childId).toBe('child-teen');
    expect(view.title).toBe(RAW_TITLE);
    expect(view.summary).toBe(RAW_SUMMARY);
    expect(view.coverageNote).toBe(RAW_COVERAGE);
    expect(view.sourceUrl).toBe(RAW_SOURCE_URL);
    expect(view.kind).toBe('support_group');
    expect(view.cadence).toBe('ongoing');
    // seasons + discoveredAt pass through for the cadence filter and freshness stamp.
    expect(view.seasons).toBeNull();
    expect(view.discoveredAt).toBe('2026-06-11T10:00:00.000Z');
    // Public venue coords pass through for the map pin (a public place, not the
    // family's location — rule #1).
    expect(view.lat).toBe(43.6777);
    expect(view.lng).toBe(-79.3534);
    expect(view.venueName).toBe('Riverdale Community Centre');
  });

  it('passes a seasonal candidate its seasons through to the view', () => {
    const view = toVillageCandidateView(
      candidate({ cadence: 'seasonal', seasons: ['summer', 'fall'] }),
      false,
      NO_ENGAGEMENT,
    );
    expect(view.seasons).toEqual(['summer', 'fall']);
  });

  it('folds the aggregate engagement (count + own-endorsed) into both teen and non-teen views', () => {
    const engaged = { endorsementCount: 5, endorsedByFamily: true, accepted: false };

    const teen = toVillageCandidateView(candidate(), true, engaged);
    const open = toVillageCandidateView(candidate({ childId: null }), false, engaged);

    // The count is an aggregate (identity-free) so it is safe even on a teen row.
    expect(teen.endorsementCount).toBe(5);
    expect(teen.endorsedByFamily).toBe(true);
    expect(open.endorsementCount).toBe(5);
    expect(open.endorseHref).toBe('/api/village/cand-1/endorse');
    expect(open.shareHref).toBe('/api/village/cand-1/share');
  });

  it('folds the family-accepted flag through so the accept button can render "added" on load', () => {
    const accepted = { endorsementCount: 0, endorsedByFamily: false, accepted: true };

    const open = toVillageCandidateView(candidate({ childId: null }), false, accepted);
    const notAccepted = toVillageCandidateView(candidate({ childId: null }), false, NO_ENGAGEMENT);

    expect(open.accepted).toBe(true);
    expect(notAccepted.accepted).toBe(false);
  });
});

describe('filterCandidatesByScope', () => {
  const forChild = (id: string, childId: string | null) =>
    toVillageCandidateView(candidate({ id, childId }), false, NO_ENGAGEMENT);

  const NADIA = 'child-nadia';
  const OMAR = 'child-omar';
  const nadiaPick = forChild('c-nadia', NADIA);
  const omarPick = forChild('c-omar', OMAR);
  const familyPick = forChild('c-family', null);

  it('whole family (null scope) returns every candidate, order preserved', () => {
    const all = [nadiaPick, omarPick, familyPick];
    expect(filterCandidatesByScope(all, null)).toEqual(all);
  });

  it("a child scope keeps that child's picks AND the family-wide picks, drops other children", () => {
    const result = filterCandidatesByScope([nadiaPick, omarPick, familyPick], NADIA);
    expect(result.map((c) => c.id)).toEqual(['c-nadia', 'c-family']);
  });
});

describe('filterCandidatesByCadence', () => {
  const byCadence = (id: string, cadence: string | null) =>
    toVillageCandidateView(candidate({ id, childId: null, cadence }), false, NO_ENGAGEMENT);

  const oneTime = byCadence('c-once', 'one-time');
  const seasonal = byCadence('c-season', 'seasonal');
  const ongoing = byCadence('c-ongoing', 'ongoing');
  const unclassified = byCadence('c-null', null);
  const all = [oneTime, seasonal, ongoing, unclassified];

  it('"all" narrows nothing', () => {
    expect(filterCandidatesByCadence(all, 'all')).toEqual(all);
  });

  it('"year-round" keeps only the stored ongoing cadence (never renders the raw token)', () => {
    expect(filterCandidatesByCadence(all, 'year-round').map((c) => c.id)).toEqual(['c-ongoing']);
  });

  it('a specific filter keeps only its cadence and drops the unclassified row', () => {
    expect(filterCandidatesByCadence(all, 'one-time').map((c) => c.id)).toEqual(['c-once']);
    expect(filterCandidatesByCadence(all, 'seasonal').map((c) => c.id)).toEqual(['c-season']);
  });
});

describe('toRoutineProposalView', () => {
  it('redacts only the item whose childId is in the teen set; leaves a family-wide item alone', () => {
    const view = toRoutineProposalView(
      proposal({
        items: [
          { title: RAW_TITLE, kind: 'support_group', childId: 'child-teen', stageNote: RAW_SUMMARY },
          {
            title: 'Saturday family swim',
            kind: 'activity',
            childId: null,
            stageNote: 'good for the whole household',
          },
        ],
      }),
      new Set(['child-teen']),
    );

    const teenItem = view.items[0];
    const familyItem = view.items[1];

    // The teen-attributed item: category survives, title/stageNote redacted.
    expect(teenItem?.teenAttributed).toBe(true);
    expect(teenItem?.kind).toBe('support_group');
    expect(teenItem?.title).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(teenItem?.stageNote).toBe(TEEN_REDACTED_PLACEHOLDER);

    // The family-wide item (childId null) is never redacted.
    expect(familyItem?.teenAttributed).toBe(false);
    expect(familyItem?.title).toBe('Saturday family swim');
    expect(familyItem?.stageNote).toBe('good for the whole household');

    // No raw teen text anywhere in the serialized proposal.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(RAW_TITLE);
    expect(serialized).not.toContain(RAW_SUMMARY);
  });

  it('carries the item day through the view (a weekday, not PII — survives teen redaction)', () => {
    const view = toRoutineProposalView(
      proposal({
        items: [
          { title: RAW_TITLE, kind: 'support_group', childId: 'child-teen', stageNote: RAW_SUMMARY, day: 'tuesday' },
          { title: 'Saturday family swim', kind: 'activity', childId: null, stageNote: 'household', day: 'saturday' },
        ],
      }),
      new Set(['child-teen']),
    );

    // The weekday is a placement label, not raw content: it survives even on the
    // redacted teen item, so the week-strip can still show where an item sits.
    expect(view.items[0]?.day).toBe('tuesday');
    expect(view.items[0]?.teenAttributed).toBe(true);
    expect(view.items[1]?.day).toBe('saturday');
  });

  it('reads a pre-day row (no day field) back as null, never undefined', () => {
    const view = toRoutineProposalView(
      proposal({ items: [{ title: 'Storytime', kind: 'library', childId: null, stageNote: 'toddler' }] }),
      new Set(),
    );
    expect(view.items[0]?.day).toBeNull();
  });
});
