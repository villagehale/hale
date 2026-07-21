import { describe, expect, it, vi } from 'vitest';

// The component imports the audited server action (→ next-auth, unresolvable under
// vitest); stub it so importing the pure rollback helper resolves.
vi.mock('~/lib/settings/loop-prefs-actions', () => ({ setLoopPrefAction: vi.fn() }));

import { rollbackPref } from '~/components/hale/loop-prefs';
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
