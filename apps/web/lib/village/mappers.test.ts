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
    rating: null,
    ratingCount: null,
    placeId: null,
    priceLevel: null,
    ageRange: null,
    indoorOutdoor: null,
    shareToken: null,
    eventDate: null,
    seasons: null,
    runType: 'standing',
    searchSeason: null,
    supersededAt: null,
    discoveredAt: new Date('2026-06-11T10:00:00Z'),
    ...overrides,
  };
}

const NO_ENGAGEMENT = {
  endorsementCount: 0,
  endorsedByFamily: false,
  accepted: false,
  saved: false,
};

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

  it('parses the numeric rating string to a number and passes attributes through', () => {
    const view = toVillageCandidateView(
      candidate({
        childId: null,
        // numeric(2,1) reads back as a fixed-point string.
        rating: '4.6' as unknown as VillageCandidate['rating'],
        ratingCount: 128,
        priceLevel: 'free',
        ageRange: '2–6 years',
        indoorOutdoor: 'outdoor',
      }),
      false,
      NO_ENGAGEMENT,
    );
    expect(view.rating).toBe(4.6);
    expect(view.ratingCount).toBe(128);
    expect(view.priceLevel).toBe('free');
    expect(view.ageRange).toBe('2–6 years');
    expect(view.indoorOutdoor).toBe('outdoor');
  });

  it('leaves rating null (no fabrication) when the column is null', () => {
    const view = toVillageCandidateView(candidate({ childId: null }), false, NO_ENGAGEMENT);
    expect(view.rating).toBeNull();
    expect(view.ratingCount).toBeNull();
    expect(view.priceLevel).toBeNull();
  });

  it('nulls rating + all attributes on a teen-redacted card (no metadata leak, rule #1)', () => {
    const view = toVillageCandidateView(
      candidate({
        rating: '4.9' as unknown as VillageCandidate['rating'],
        ratingCount: 500,
        priceLevel: 'high',
        ageRange: '13–17 years',
        indoorOutdoor: 'indoor',
      }),
      true,
      NO_ENGAGEMENT,
    );
    expect(view.rating).toBeNull();
    expect(view.ratingCount).toBeNull();
    expect(view.priceLevel).toBeNull();
    expect(view.ageRange).toBeNull();
    expect(view.indoorOutdoor).toBeNull();
  });

  it('passes a seasonal candidate its seasons through to the view', () => {
    const view = toVillageCandidateView(
      candidate({ cadence: 'seasonal', seasons: ['summer', 'fall'] }),
      false,
      NO_ENGAGEMENT,
    );
    expect(view.seasons).toEqual(['summer', 'fall']);
  });

  it('threads eventDate through on a non-teen card and nulls it on a teen card (rule #1)', () => {
    const open = toVillageCandidateView(
      candidate({ childId: null, eventDate: '2026-09-12' }),
      false,
      NO_ENGAGEMENT,
    );
    expect(open.eventDate).toBe('2026-09-12');

    const teen = toVillageCandidateView(candidate({ eventDate: '2026-09-12' }), true, NO_ENGAGEMENT);
    expect(teen.eventDate).toBeNull();
  });

  it('folds the aggregate engagement (count + own-endorsed) into both teen and non-teen views', () => {
    const engaged = { endorsementCount: 5, endorsedByFamily: true, accepted: false, saved: false };

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
    const accepted = { endorsementCount: 0, endorsedByFamily: false, accepted: true, saved: false };

    const open = toVillageCandidateView(candidate({ childId: null }), false, accepted);
    const notAccepted = toVillageCandidateView(candidate({ childId: null }), false, NO_ENGAGEMENT);

    expect(open.accepted).toBe(true);
    expect(notAccepted.accepted).toBe(false);
  });

  it('folds the private saved flag through and always resolves the saveHref (both teen and non-teen)', () => {
    // A save is PRIVATE (only ever this family's own), so the flag and the toggle
    // href are safe even on a teen-attributed card — its content stays redacted.
    const saved = { endorsementCount: 0, endorsedByFamily: false, accepted: false, saved: true };

    const teen = toVillageCandidateView(candidate(), true, saved);
    const open = toVillageCandidateView(candidate({ childId: null }), false, saved);
    const unsaved = toVillageCandidateView(candidate({ childId: null }), false, NO_ENGAGEMENT);

    expect(open.saved).toBe(true);
    expect(teen.saved).toBe(true);
    expect(unsaved.saved).toBe(false);
    expect(open.saveHref).toBe('/api/village/cand-1/save');
    expect(teen.saveHref).toBe('/api/village/cand-1/save');
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
  // A null-cadence row with no date/season DERIVES to ongoing (effectiveCadence), so
  // it is filterable under year-round now instead of stranded under "all" only — the
  // reported bug. Its derivation is unit-tested in cadence.test.ts.
  const derivedOngoing = byCadence('c-null', null);
  const all = [oneTime, seasonal, ongoing, derivedOngoing];

  it('"all" narrows nothing', () => {
    expect(filterCandidatesByCadence(all, 'all')).toEqual(all);
  });

  it('"year-round" keeps ongoing rows — stored AND derived-from-null (never renders the raw token)', () => {
    expect(filterCandidatesByCadence(all, 'year-round').map((c) => c.id)).toEqual([
      'c-ongoing',
      'c-null',
    ]);
  });

  it('a one-time / seasonal filter keeps only that cadence (a derived-ongoing null row does not match)', () => {
    expect(filterCandidatesByCadence(all, 'one-time').map((c) => c.id)).toEqual(['c-once']);
    expect(filterCandidatesByCadence(all, 'seasonal').map((c) => c.id)).toEqual(['c-season']);
  });
});

describe('toRoutineProposalView', () => {
  it('redacts only the item whose childId is in the teen set; leaves a family-wide item alone', () => {
    const view = toRoutineProposalView(
      proposal({
        items: [
          {
            title: RAW_TITLE,
            kind: 'support_group',
            childId: 'child-teen',
            stageNote: RAW_SUMMARY,
          },
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
          {
            title: RAW_TITLE,
            kind: 'support_group',
            childId: 'child-teen',
            stageNote: RAW_SUMMARY,
            day: 'tuesday',
          },
          {
            title: 'Saturday family swim',
            kind: 'activity',
            childId: null,
            stageNote: 'household',
            day: 'saturday',
          },
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
      proposal({
        items: [{ title: 'Storytime', kind: 'library', childId: null, stageNote: 'toddler' }],
      }),
      new Set(),
    );
    expect(view.items[0]?.day).toBeNull();
  });
});
