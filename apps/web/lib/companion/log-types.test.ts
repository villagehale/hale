import { describe, expect, it } from 'vitest';
import { NAP_EPISODE, napSchema, resolveNapWindow } from './log-types.js';

/**
 * The nap quick-log accepts EITHER a plain duration OR a start/end window (an
 * additive extension — the direct durationMin entry keeps working). The schema
 * stays a plain ZodObject (a valid member of the discriminated union) and does NOT
 * enforce the cross-field rules; it only validates each bound's shape (ISO w/
 * offset). The rules — a window needs BOTH bounds, and a nap needs EITHER a
 * duration OR a window — are enforced at the boundary by resolveNapWindow /
 * resolveNap, which also turn a valid window into a whole-minute duration with the
 * same range discipline as occurredAt (real date, not future, not absurdly old, end
 * after start). Expected values are derived from the spec, not copied from output.
 */

const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-07T18:00:00Z');

describe('napSchema — additive window fields (a plain ZodObject for the union)', () => {
  it('accepts a plain durationMin with no window (the original entry still works)', () => {
    const parsed = napSchema.safeParse({ kind: NAP_EPISODE, childId: CHILD_ID, durationMin: 45 });
    expect(parsed.success).toBe(true);
  });

  it('accepts a start/end window with no durationMin', () => {
    const parsed = napSchema.safeParse({
      kind: NAP_EPISODE,
      childId: CHILD_ID,
      startAt: '2026-07-07T14:00:00Z',
      endAt: '2026-07-07T15:30:00Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-ISO bound (offset required, like occurredAt)', () => {
    const parsed = napSchema.safeParse({
      kind: NAP_EPISODE,
      childId: CHILD_ID,
      startAt: 'yesterday afternoon',
      endAt: '2026-07-07T15:30:00Z',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('resolveNapWindow — derives a whole-minute duration', () => {
  it('returns null (no window) when both bounds are omitted', () => {
    expect(resolveNapWindow(undefined, undefined, NOW)).toEqual({ ok: true, durationMin: null });
  });

  it('rejects a lone start with no end (an incomplete window)', () => {
    const r = resolveNapWindow('2026-07-07T14:00:00Z', undefined, NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects a lone end with no start (an incomplete window)', () => {
    const r = resolveNapWindow(undefined, '2026-07-07T15:00:00Z', NOW);
    expect(r.ok).toBe(false);
  });

  it('derives 90 minutes from a 90-minute window', () => {
    const r = resolveNapWindow('2026-07-07T14:00:00Z', '2026-07-07T15:30:00Z', NOW);
    expect(r).toEqual({ ok: true, durationMin: 90 });
  });

  it('rounds a fractional window to whole minutes', () => {
    // 45m40s → 46 min (rounded).
    const r = resolveNapWindow('2026-07-07T14:00:00Z', '2026-07-07T14:45:40Z', NOW);
    expect(r).toEqual({ ok: true, durationMin: 46 });
  });

  it('rejects an end at or before the start', () => {
    const r = resolveNapWindow('2026-07-07T15:00:00Z', '2026-07-07T14:00:00Z', NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects a window in the future (same skew bound as occurredAt)', () => {
    const r = resolveNapWindow('2026-07-07T19:00:00Z', '2026-07-07T20:00:00Z', NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects a window longer than a day', () => {
    const r = resolveNapWindow('2026-07-05T10:00:00Z', '2026-07-07T11:00:00Z', NOW);
    expect(r.ok).toBe(false);
  });
});
