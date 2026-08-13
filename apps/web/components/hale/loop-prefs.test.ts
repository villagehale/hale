import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The component imports the audited server action (→ next-auth, unresolvable under
// vitest); stub it so importing the pure rollback helper resolves.
vi.mock('~/lib/settings/loop-prefs-actions', () => ({ setLoopPrefAction: vi.fn() }));

import { LoopPrefs, rollbackPref } from '~/components/hale/loop-prefs';
import { DEFAULT_LOOP_PREFS, type LoopPrefsView } from '~/lib/loop/prefs';

const view = (over: Partial<LoopPrefsView> = {}): LoopPrefsView => ({
  ...DEFAULT_LOOP_PREFS,
  ...over,
});

/**
 * A failed optimistic save must roll back ONLY its own field. If a parent toggles two
 * categories quickly, the first save's failure must not rewind the second's successful
 * write — a stale full-snapshot restore would leave the control ON while the server
 * holds OFF until reload (WP-7).
 */
describe('rollbackPref — revert only the failed field, functionally', () => {
  it('reverts the failed field to its pre-optimistic value', () => {
    const current = view({ catWeeklyPlan: false }); // optimistically toggled off
    const previous = view({ catWeeklyPlan: true }); // its value before this save
    expect(rollbackPref(current, previous, 'catWeeklyPlan').catWeeklyPlan).toBe(true);
  });

  it('PRESERVES a different field a concurrent save changed in the meantime', () => {
    // Toggle A (catWeeklyPlan) off, then B (catReminder) off — B's save succeeds; A's
    // save then fails. Rolling A back must not resurrect B's old (on) value.
    const current = view({ catWeeklyPlan: false, catReminder: false });
    const previousBeforeA = view({ catWeeklyPlan: true, catReminder: true });
    const rolled = rollbackPref(current, previousBeforeA, 'catWeeklyPlan');
    expect(rolled.catWeeklyPlan).toBe(true); // A's failed toggle reverted
    expect(rolled.catReminder).toBe(false); // B's concurrent success kept
  });
});

/**
 * The Text option told every family "Text arrives when SMS launches" — hardcoded,
 * regardless of the family's actual channel. SMS is the product's PRIMARY live
 * channel (D1), so for a family already texting Hale that note was simply false,
 * and the control they most wanted was greyed out. The option now follows the live
 * `parent_channels` row: offered when texting actually works, honestly held back
 * when it does not.
 */
describe('the Text loop channel follows the real SMS channel', () => {
  const ready = (smsEnrolled: boolean) =>
    renderToStaticMarkup(
      createElement(LoopPrefs, {
        result: { status: 'ready' as const, prefs: DEFAULT_LOOP_PREFS, smsEnrolled },
      }),
    );

  it('offers Text as a real choice to a family with a live SMS channel', () => {
    const html = ready(true);
    // The Text radio is the second one; with SMS live neither radio may be disabled.
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('when SMS launches');
  });

  it('still holds Text back — and says why — for a family with no SMS channel', () => {
    const html = ready(false);
    expect(html).toContain('disabled');
    expect(html).toContain('Text Hale first');
  });
});
