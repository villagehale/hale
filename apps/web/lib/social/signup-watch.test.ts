import { describe, expect, it } from 'vitest';
import {
  ARM_LEAD_MS,
  FIRE_GRACE_MS,
  type SignupWatchStore,
  enqueueSignupWatch,
  readRegistrationPage,
  runSignupWatchTick,
  signupPhase,
  signupWatchJobs,
} from './signup-watch';

const OPENS = new Date('2026-10-01T13:00:00.000Z');

describe('signupPhase', () => {
  it('arms fifteen minutes before open and fires through the two minutes after', () => {
    expect(signupPhase(new Date(OPENS.getTime() - ARM_LEAD_MS - 1), OPENS)).toBe('wait');
    expect(signupPhase(new Date(OPENS.getTime() - ARM_LEAD_MS), OPENS)).toBe('arm');
    expect(signupPhase(OPENS, OPENS)).toBe('fire');
    expect(signupPhase(new Date(OPENS.getTime() + FIRE_GRACE_MS), OPENS)).toBe('fire');
    expect(signupPhase(new Date(OPENS.getTime() + FIRE_GRACE_MS + 1), OPENS)).toBe('missed');
  });
});

describe('enqueueSignupWatch', () => {
  it('names a missing clock and a missing queue', async () => {
    expect(
      await enqueueSignupWatch({ id: 's', registrationOpensAt: null, registrationUrl: null }, null),
    ).toEqual({ status: 'skipped', skipped: 'no_registration_clock' });
    const scheduled = await enqueueSignupWatch(
      { id: 's', registrationOpensAt: OPENS, registrationUrl: 'https://farm.example/reg' },
      null,
    );
    expect(scheduled.status).toBe('scheduled');
    if (scheduled.status === 'scheduled') expect(scheduled.skipped).toBe('queue_not_configured');
    expect(signupWatchJobs(OPENS).map((job) => job.phase)).toEqual(['arm', 'fire', 'follow_up']);
  });

  it('names a queue that throws and still returns the three wakes', async () => {
    const result = await enqueueSignupWatch(
      { id: 's', registrationOpensAt: OPENS, registrationUrl: 'https://farm.example/reg' },
      {
        send: async () => {
          throw new Error('down');
        },
      },
    );
    expect(result.status).toBe('scheduled');
    if (result.status === 'scheduled') expect(result.skipped).toBe('queue_unavailable');
  });
});

describe('runSignupWatchTick', () => {
  function memory(row: {
    id: string;
    registrationOpensAt: Date;
    registrationUrl: string;
    watchStatus: 'scheduled' | 'armed';
  }): SignupWatchStore & { saved: { watchStatus: string; nextWakeAt: Date | null }[] } {
    const saved: { watchStatus: string; nextWakeAt: Date | null }[] = [];
    return {
      saved,
      async due() {
        return [row];
      },
      async save(_id, patch) {
        saved.push(patch);
      },
    };
  }

  it('reads the registration url inside the two-minute fire window', async () => {
    const store = memory({
      id: 'spot-1',
      registrationOpensAt: OPENS,
      registrationUrl: 'https://farm.example/reg',
      watchStatus: 'armed',
    });
    let fetched = '';
    const result = await runSignupWatchTick(
      new Date(OPENS.getTime() + 30_000),
      store,
      async (url) => {
        fetched = url;
        return { ok: true, html: '<html>register</html>' };
      },
    );
    expect(fetched).toBe('https://farm.example/reg');
    expect(result.results[0]).toEqual({ id: 'spot-1', watchStatus: 'fired', page: 'open' });
  });

  it('marks a sold-out page filled and an unreadable page armed for another minute', async () => {
    expect(readRegistrationPage('sorry, sold out', true)).toBe('filled');
    const filled = memory({
      id: 'spot-2',
      registrationOpensAt: OPENS,
      registrationUrl: 'https://farm.example/reg',
      watchStatus: 'armed',
    });
    await runSignupWatchTick(OPENS, filled, async () => ({ ok: true, html: 'fully booked' }));
    expect(filled.saved[0]?.watchStatus).toBe('filled');

    const now = OPENS;
    const unread = memory({
      id: 'spot-3',
      registrationOpensAt: OPENS,
      registrationUrl: 'https://farm.example/reg',
      watchStatus: 'armed',
    });
    await runSignupWatchTick(now, unread, async () => ({ ok: false, html: '' }));
    expect(unread.saved[0]?.watchStatus).toBe('armed');
    expect(unread.saved[0]?.nextWakeAt?.getTime()).toBe(now.getTime() + 60_000);
  });

  it('misses a watch that is still open after the two-minute window', async () => {
    const store = memory({
      id: 'spot-4',
      registrationOpensAt: OPENS,
      registrationUrl: 'https://farm.example/reg',
      watchStatus: 'armed',
    });
    await runSignupWatchTick(new Date(OPENS.getTime() + FIRE_GRACE_MS + 5_000), store, async () => {
      throw new Error('should not fetch');
    });
    expect(store.saved[0]).toEqual({ watchStatus: 'missed', nextWakeAt: null });
  });
});
