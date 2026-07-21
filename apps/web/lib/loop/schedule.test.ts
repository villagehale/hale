import { describe, expect, it } from 'vitest';
import { weekWindow } from '~/lib/plan/spine';
import { DEFAULT_SEND_WINDOW, isInSendWindow } from './schedule';

/**
 * The weekly-plan cron fires hourly and must select each family at its OWN local
 * send window — the honest version of the digest cron's fixed-UTC + Toronto cheat.
 * These assert the family-local boundary math from first principles (a chosen local
 * wall-clock → the UTC instant it maps to in a zone), across DST and :30/:45 offset
 * zones — never by reading back the function's output.
 */

/** The UTC instant a given family-local wall-clock maps to in `tz` (DST-correct via
 * the offset at that instant — one correction step, exact away from transitions). */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

const TORONTO = 'America/Toronto';

describe('isInSendWindow — default Saturday 19:30 family-local, hourly tick', () => {
  it('matches from the window open through <60 minutes later, not before or at +60', () => {
    // 2026-07-25 is a Saturday (EDT, UTC-4).
    expect(isInSendWindow(zoned(2026, 7, 25, 19, 30, TORONTO), TORONTO)).toBe(true); // exact open
    expect(isInSendWindow(zoned(2026, 7, 25, 20, 29, TORONTO), TORONTO)).toBe(true); // +59 min
    expect(isInSendWindow(zoned(2026, 7, 25, 19, 29, TORONTO), TORONTO)).toBe(false); // 1 min early
    expect(isInSendWindow(zoned(2026, 7, 25, 20, 30, TORONTO), TORONTO)).toBe(false); // +60 (next tick)
  });

  it('rejects the right local time on the wrong weekday', () => {
    expect(isInSendWindow(zoned(2026, 7, 26, 19, 45, TORONTO), TORONTO)).toBe(false); // Sunday
  });

  it('is per-family-local: one UTC instant fires one zone and not another', () => {
    // Saturday 19:30 in Vancouver (PDT, UTC-7) — the SAME instant is Saturday 22:30
    // in Toronto (EDT), 3h past its window. The digest cron's fixed-UTC fire could
    // never do this.
    const instant = zoned(2026, 7, 25, 19, 30, 'America/Vancouver');
    expect(isInSendWindow(instant, 'America/Vancouver')).toBe(true);
    expect(isInSendWindow(instant, TORONTO)).toBe(false);
  });

  it('reads the offset live across DST — same local time, different UTC instant', () => {
    // Winter (EST, UTC-5) vs the summer case above (EDT, UTC-4): both are Sat 19:30
    // LOCAL, so both must fire, proving the offset is read at the instant, not fixed.
    expect(isInSendWindow(zoned(2026, 1, 31, 19, 30, TORONTO), TORONTO)).toBe(true);
  });

  it('catches a :30-offset zone (Newfoundland) that fixed-minute equality would miss', () => {
    expect(isInSendWindow(zoned(2026, 1, 31, 19, 30, 'America/St_Johns'), 'America/St_Johns')).toBe(
      true,
    );
  });

  it('catches a :45-offset zone (Nepal) — the slot is a whole tick wide', () => {
    // 2026-07-25 Saturday; Kathmandu is UTC+5:45, so hourly UTC ticks land at local
    // :15/:45 — a fixed :30 equality would NEVER match. The 60-min slot does.
    expect(isInSendWindow(zoned(2026, 7, 25, 19, 45, 'Asia/Kathmandu'), 'Asia/Kathmandu')).toBe(
      true,
    );
  });

  it('DEFAULT_SEND_WINDOW is Saturday 19:30', () => {
    expect(DEFAULT_SEND_WINDOW).toEqual({ weekday: 5, hour: 19, minute: 30 });
  });
});

describe('weekWindow — the upcoming family-local week the composer covers', () => {
  it('weekOffset 1 from a Saturday returns the NEXT Monday..Sunday', () => {
    // Sat 2026-07-25 local → this-week Monday 2026-07-20 → next week Mon 2026-07-27.
    const w = weekWindow(zoned(2026, 7, 25, 19, 30, TORONTO), TORONTO, 1, 1);
    expect(w.startKey).toBe('2026-07-27');
    expect(w.endKey).toBe('2026-08-02');
    expect(w.dayKeys).toHaveLength(7);
    expect(w.dayKeys[0]).toBe('2026-07-27');
    expect(w.dayKeys[6]).toBe('2026-08-02');
  });

  it('reads "today" in the family zone: late-Saturday-ET instant is still Saturday local', () => {
    // 23:30 ET Saturday is 03:30 UTC Sunday — the window must key off Saturday LOCAL.
    const w = weekWindow(zoned(2026, 7, 25, 23, 30, TORONTO), TORONTO, 1, 1);
    expect(w.startKey).toBe('2026-07-27');
  });

  it('produces contiguous keys across a DST spring-forward week (no gap/dupe)', () => {
    // US DST spring-forward 2026-03-08; the composed week that spans it must still be
    // seven contiguous calendar days.
    const w = weekWindow(zoned(2026, 3, 7, 19, 30, TORONTO), TORONTO, 1, 1);
    expect(w.dayKeys).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
      '2026-03-15',
    ]);
  });
});
