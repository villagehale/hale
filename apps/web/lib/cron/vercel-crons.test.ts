import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE SCHEDULE IS A LOAD PROFILE, and this holds it to one.
 *
 * Every scheduled leg used to fire at `0 * * * *`. At the top of every hour that was a
 * dozen invocations opening database connections at the same instant — and worse, the
 * four legs that TEXT parents (reminders, nudge, party guests, the weekly plan) all
 * queued their sends into the same minute, onto one Canadian long code that transmits
 * about one segment per second. A hundred families in one timezone all match the same
 * local hour, so the pile-up is not theoretical: it is the campaign.
 *
 * The invariant: a cron with a FIXED minute gets that minute to itself, and never sits
 * on a minute one of the recurring sweeps (`*​/5`, `*​/10`, `*​/15`) already occupies.
 * It is checked against the real vercel.json because that file is the only thing the
 * platform reads — a constant in TypeScript would be a copy that drifts.
 */

const CRON_CONFIG = fileURLToPath(new URL('../../vercel.json', import.meta.url));

interface CronEntry {
  path: string;
  schedule: string;
}

function crons(): CronEntry[] {
  return (JSON.parse(readFileSync(CRON_CONFIG, 'utf8')) as { crons: CronEntry[] }).crons;
}

function minuteField(schedule: string): string {
  const field = schedule.split(' ')[0];
  if (!field) throw new Error(`cron schedule has no minute field: ${schedule}`);
  return field;
}

/** The minutes of the hour a `*​/N` (or `*`) minute field fires at. */
function sweepMinutes(field: string): number[] {
  if (field === '*') return Array.from({ length: 60 }, (_, minute) => minute);
  const step = Number(field.slice(2));
  const minutes: number[] = [];
  for (let minute = 0; minute < 60; minute += step) minutes.push(minute);
  return minutes;
}

/**
 * The every-minute drain is deliberately outside the rule: it is the constant this
 * whole design leans on (the safety-net reaper behind every kick), so it cannot be
 * staggered and every other cron necessarily shares its minute.
 */
const EVERY_MINUTE = '/api/cron/drain';

describe('vercel cron schedule', () => {
  it('gives every fixed-minute cron a minute of its own', () => {
    const byMinute = new Map<number, string[]>();
    for (const cron of crons()) {
      const field = minuteField(cron.schedule);
      if (field.startsWith('*')) continue;
      const minute = Number(field);
      byMinute.set(minute, [...(byMinute.get(minute) ?? []), cron.path]);
    }

    const shared = [...byMinute.entries()].filter(([, paths]) => paths.length > 1);
    expect(shared).toEqual([]);
  });

  it('keeps fixed-minute crons off the recurring sweeps’ minutes', () => {
    const all = crons();
    const occupied = new Set(
      all
        .filter((cron) => cron.path !== EVERY_MINUTE && minuteField(cron.schedule).startsWith('*'))
        .flatMap((cron) => sweepMinutes(minuteField(cron.schedule))),
    );
    // A positive control on the set itself: if this were empty the test would pass on
    // any schedule at all.
    expect(occupied.size).toBeGreaterThan(0);

    const collisions = all
      .filter((cron) => !minuteField(cron.schedule).startsWith('*'))
      .filter((cron) => occupied.has(Number(minuteField(cron.schedule))))
      .map((cron) => `${cron.path} @ ${cron.schedule}`);
    expect(collisions).toEqual([]);
  });

  it('still runs the drain every minute — the stagger must not touch the reaper', () => {
    const drain = crons().find((cron) => cron.path === EVERY_MINUTE);
    expect(drain?.schedule).toBe('* * * * *');
  });
});
