import { describe, expect, it } from 'vitest';
import { companionHighlightsForChildren } from './daily-digest.js';

/**
 * companionHighlightsForChildren — the pure F1 companion nudge derivation for
 * the daily brief (no DB, no LLM). Expected values trace to the curated
 * schedule: Canadian immunizations at 2/4/6/12/15/18 months, and the milestone
 * windows in @hale/types. `now` is fixed so completed-month ages are exact.
 */
const NOW = new Date(2026, 5, 15); // 2026-06-15

describe('companionHighlightsForChildren', () => {
  it("nudges a 3-month-old's 4-month immunizations as due in ~4 weeks", () => {
    // Born 2026-03-15 → exactly 3mo. Soonest health item is the 4-month set
    // (~1 month out → 4 weeks, within the 6-week "soon" window).
    const highlights = companionHighlightsForChildren(
      [{ id: 'maya', name: 'Maya', dateOfBirth: '2026-03-15' }],
      NOW,
    );

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.childId).toBe('maya');
    // The health note names the child, the item, and the coarse timing.
    expect(highlights[0]?.notes.some((n) => n.includes("Maya's 4-month"))).toBe(true);
    expect(highlights[0]?.notes.some((n) => n.includes('4 weeks'))).toBe(true);
  });

  it('surfaces an in-window milestone for a 13-month-old (walking / first words)', () => {
    // Born 2025-05-15 → 13mo → toddler. "Walks independently" [12,18] is in-window.
    const highlights = companionHighlightsForChildren(
      [{ id: 'ezra', name: 'Ezra', dateOfBirth: '2025-05-15' }],
      NOW,
    );

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.notes.some((n) => n.includes('walks independently'))).toBe(true);
  });

  it('omits a child with no soon-due health item and no in-window milestone', () => {
    // Born 2024-12-15 → 18mo exactly. The 18-month items are due now (included),
    // so to test omission use an age with the next item far off AND past every
    // toddler in-window milestone top-bound. A 47-month-old (born 2022-07-15):
    // next health item is 4–6y (60mo, ~13 months out → beyond 6-week window),
    // and all toddler milestone windows top out at 42mo → none in-window.
    const highlights = companionHighlightsForChildren(
      [{ id: 'quiet', name: 'Quiet', dateOfBirth: '2022-07-15' }],
      NOW,
    );
    expect(highlights).toHaveLength(0);
  });

  it('handles multiple siblings independently, omitting those with nothing soon', () => {
    const highlights = companionHighlightsForChildren(
      [
        { id: 'maya', name: 'Maya', dateOfBirth: '2026-03-15' }, // 3mo → has a nudge
        { id: 'quiet', name: 'Quiet', dateOfBirth: '2022-07-15' }, // 47mo → omitted
      ],
      NOW,
    );
    expect(highlights.map((h) => h.childId)).toEqual(['maya']);
  });
});
