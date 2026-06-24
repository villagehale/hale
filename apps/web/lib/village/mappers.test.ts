import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '../dashboard/mappers.js';
import {
  type RoutineProposal,
  type VillageCandidate,
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
    summary: RAW_SUMMARY,
    sourceUrl: RAW_SOURCE_URL,
    source: 'web_grounded',
    confidence: 0.9,
    coverageNote: RAW_COVERAGE,
    discoveredAt: new Date('2026-06-11T10:00:00Z'),
    ...overrides,
  };
}

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
    const view = toVillageCandidateView(candidate(), true);

    // Rule #1: only the category survives. The title carries the one redaction
    // line; summary is empty so the renderer states the why exactly once.
    expect(view.teenAttributed).toBe(true);
    expect(view.title).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.summary).toBe('');
    expect(view.coverageNote).toBeNull();
    expect(view.sourceUrl).toBeNull();
    expect(view.kind).toBe('support_group');

    // Structural guarantee: no raw discovered text reaches the view at all.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(RAW_TITLE);
    expect(serialized).not.toContain(RAW_SUMMARY);
    expect(serialized).not.toContain(RAW_COVERAGE);
    expect(serialized).not.toContain(RAW_SOURCE_URL);
  });

  it('passes every raw field through unchanged and unmarked when NOT teen-attributed', () => {
    const view = toVillageCandidateView(candidate(), false);

    expect(view.teenAttributed).toBe(false);
    expect(view.title).toBe(RAW_TITLE);
    expect(view.summary).toBe(RAW_SUMMARY);
    expect(view.coverageNote).toBe(RAW_COVERAGE);
    expect(view.sourceUrl).toBe(RAW_SOURCE_URL);
    expect(view.kind).toBe('support_group');
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
});
