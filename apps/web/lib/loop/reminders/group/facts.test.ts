import { describe, expect, it } from 'vitest';
import { type DueReminder, reminderFacts } from './facts';

const tz = 'America/Toronto';
const base = (askedForAt: string, deliverAt: string): DueReminder => ({
  forKind: 'sender',
  delivery: 'group',
  language: 'en',
  what: 'put the bins out',
  askedForAt: new Date(askedForAt),
  deliverAt: new Date(deliverAt),
});
const facts = (r: DueReminder) =>
  reminderFacts({
    reminder: r,
    askerName: 'Ruth',
    recipientName: null,
    now: r.deliverAt,
    timeZone: tz,
  });

describe('reminderFacts move direction', () => {
  it('quiet hours moved it earlier', () => {
    const f = facts(base('2026-10-29T02:30:00Z', '2026-10-29T00:45:00Z'));
    expect(f.moved).toBe('earlier');
    expect(f.askedFor).toContain('10:30');
    expect(f.sendsAt).toContain('8:45');
    expect(f.movedBecause).toBe('quiet_hours');
  });
  it('quiet hours moved it later', () => {
    const f = facts(base('2026-10-29T09:30:00Z', '2026-10-29T12:00:00Z'));
    expect(f.moved).toBe('later');
    expect(f.askedFor).not.toBeNull();
  });
  it('not moved', () => {
    const f = facts(base('2026-10-29T19:00:00Z', '2026-10-29T19:00:00Z'));
    expect(f.moved).toBeNull();
    expect(f.askedFor).toBeNull();
    expect(f.movedBecause).toBeNull();
    expect(f.sendsAt).toBe(f.now);
  });
});
