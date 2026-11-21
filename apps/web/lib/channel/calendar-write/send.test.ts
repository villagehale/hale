import type { Database } from '@hale/db';
import type { GoogleCalendarPlacementRequest } from '@hale/worker/google-calendar-placement';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CalendarWriteNoticePorts,
  noticeAfterSync,
  productionCalendarWriteNoticePorts,
  withCalendarWriteNotice,
} from './send';

const REQUEST: GoogleCalendarPlacementRequest = {
  familyId: 'f1',
  familyEventId: 'e1',
  op: 'create',
  actorUserId: 'u1',
};
const EVENT = { title: 'Swim lesson', when: 'Sat, Nov 7 at 10:00 AM', where: null };
const LINK = 'https://app.villagehale.com/c/abc';

function ports(overrides: Partial<CalendarWriteNoticePorts> = {}): CalendarWriteNoticePorts {
  return {
    enabled: () => true,
    gate: vi.fn(async () => ({ allowed: true, optOut: 'short' }) as const),
    loadEvent: vi.fn(async () => ({ event: EVENT, language: 'en' })),
    connectLink: vi.fn(async () => LINK),
    compose: vi.fn(async () => 'Swim is on your calendar.'),
    send: vi.fn(async () => 'sent' as const),
    pager: { page: vi.fn(async () => 'paged' as const) },
    ...overrides,
  };
}

const WRITTEN = { status: 'written', googleEventId: 'g1' } as const;

function fakePlacement() {
  return {
    sync: vi.fn(async (_request: GoogleCalendarPlacementRequest) => WRITTEN),
    writeTarget: vi.fn(async () => ({ writes: false as const })),
  };
}

describe('VIL-454 noticeAfterSync', () => {
  it('does nothing when the flag is off', async () => {
    const p = ports({ enabled: () => false });
    expect(await noticeAfterSync(REQUEST, WRITTEN, p)).toBe('disabled');
    expect(p.send).not.toHaveBeenCalled();
  });

  it('never texts for an autonomous pass (no approving parent)', async () => {
    const p = ports();
    expect(await noticeAfterSync({ ...REQUEST, actorUserId: null }, WRITTEN, p)).toBe('no_actor');
    expect(p.send).not.toHaveBeenCalled();
  });

  it('never texts twice for a duplicate pass', async () => {
    const p = ports();
    const result = await noticeAfterSync(
      REQUEST,
      { status: 'skipped', reason: 'already_present' },
      p,
    );
    expect(result).toBe('no_news');
    expect(p.send).not.toHaveBeenCalled();
  });

  it('sends a success without minting a link', async () => {
    const p = ports();
    expect(await noticeAfterSync(REQUEST, WRITTEN, p)).toBe('sent');
    expect(p.connectLink).not.toHaveBeenCalled();
    expect(p.compose).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'added', connectLink: null }),
    );
    expect(p.send).toHaveBeenCalledWith(
      'f1',
      'u1',
      'Swim is on your calendar.',
      'short',
      'calendar_write_notice:f1:u1:e1:create',
    );
  });

  it('mints and hands the connect link when no calendar is connected', async () => {
    const p = ports();
    await noticeAfterSync(REQUEST, { status: 'skipped', reason: 'not_connected' }, p);
    expect(p.compose).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'no_calendar', connectLink: LINK }),
    );
  });

  it('sends nothing when the link could not be minted', async () => {
    const p = ports({ connectLink: vi.fn(async () => null) });
    expect(await noticeAfterSync(REQUEST, { status: 'skipped', reason: 'scope_missing' }, p)).toBe(
      'no_link',
    );
    expect(p.send).not.toHaveBeenCalled();
  });

  it('does not compose a notice already queued for the decider', async () => {
    const p = ports({ alreadyQueued: async () => true });
    expect(await noticeAfterSync(REQUEST, WRITTEN, p)).toBe('queued');
    expect(p.compose).not.toHaveBeenCalled();
    expect(p.loadEvent).not.toHaveBeenCalled();
  });

  it('sends nothing canned when the compose fails', async () => {
    const p = ports({ compose: vi.fn(async () => null) });
    expect(await noticeAfterSync(REQUEST, WRITTEN, p)).toBe('unwritten');
    expect(p.send).not.toHaveBeenCalled();
  });

  it('names a parent zone it cannot read, and composes nothing', async () => {
    const p = ports({ loadEvent: vi.fn(async () => 'zone_unreadable' as const) });
    expect(await noticeAfterSync(REQUEST, WRITTEN, p)).toBe('zone_unreadable');
    expect(p.compose).not.toHaveBeenCalled();
    expect(p.send).not.toHaveBeenCalled();
  });

  it('swallows a throw', async () => {
    const p = ports({ loadEvent: vi.fn(async () => Promise.reject(new Error('db'))) });
    expect(await noticeAfterSync(REQUEST, WRITTEN, p)).toBe('errored');
  });
});

describe('VIL-454 withCalendarWriteNotice', () => {
  it('returns the inner report untouched, even when the notice throws', async () => {
    const inner = fakePlacement();
    const wrapped = withCalendarWriteNotice(
      inner,
      ports({ send: vi.fn(async () => Promise.reject(new Error('x'))) }),
    );
    expect(await wrapped.sync(REQUEST)).toEqual(WRITTEN);
    expect(inner.sync).toHaveBeenCalledWith(REQUEST);
  });
});

describe('VIL-719 the placement behind the notice', () => {
  it('keeps answering whose calendar a write would land on', async () => {
    const writeTarget = vi.fn(async () => ({ writes: true as const, ownerUserId: 'u2' }));
    const wrapped = withCalendarWriteNotice({ ...fakePlacement(), writeTarget }, ports());
    const request = { familyId: 'f1', op: 'create', familyEventId: null, actorUserId: null } as const;
    await expect(wrapped.writeTarget(request)).resolves.toEqual({
      writes: true,
      ownerUserId: 'u2',
    });
    expect(writeTarget).toHaveBeenCalledWith(request);
  });
});

describe('VIL-719 a notice the model could not write', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('policy on: sends nothing, leaves the placement alone, and pages #ops once', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const inner = fakePlacement();
    const p = ports({ compose: vi.fn(async () => null) });
    expect(await withCalendarWriteNotice(inner, p).sync(REQUEST)).toEqual(WRITTEN);
    expect(p.send).not.toHaveBeenCalled();
    expect(p.pager.page).toHaveBeenCalledTimes(1);
    expect(p.pager.page).toHaveBeenCalledWith({
      site: 'calendar_write_notice_unwritten',
      facts: { op: 'create' },
      ref: 'e1',
    });
  });

  it('policy off: sends nothing and pages no one, as before', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const p = ports({ compose: vi.fn(async () => null) });
    await withCalendarWriteNotice(fakePlacement(), p).sync(REQUEST);
    expect(p.send).not.toHaveBeenCalled();
    expect(p.pager.page).not.toHaveBeenCalled();
  });

  it('policy on: a written notice pages no one', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const p = ports();
    await withCalendarWriteNotice(fakePlacement(), p).sync(REQUEST);
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(p.pager.page).not.toHaveBeenCalled();
  });
});

describe('VIL-454 notice passes the proactive gate first', () => {
  for (const reason of [
    'not_enrolled',
    'quiet_hours',
    'opt_out_unread',
    'no_watch_consent',
  ] as const) {
    it(`drops on ${reason}, before reading, minting, composing or sending`, async () => {
      const p = ports({ gate: vi.fn(async () => ({ allowed: false, reason }) as const) });
      expect(
        await noticeAfterSync(REQUEST, { status: 'skipped', reason: 'not_connected' }, p),
      ).toBe(`held:${reason}`);
      expect(p.loadEvent).not.toHaveBeenCalled();
      expect(p.connectLink).not.toHaveBeenCalled();
      expect(p.compose).not.toHaveBeenCalled();
      expect(p.send).not.toHaveBeenCalled();
    });
  }

  it('gates the approving parent at the injected clock', async () => {
    const now = new Date('2026-11-07T03:00:00.000Z');
    const p = ports({ now: () => now });
    await noticeAfterSync(REQUEST, WRITTEN, p);
    expect(p.gate).toHaveBeenCalledWith('f1', 'u1', now);
  });
});

describe('VIL-454 production ports build no transport up front', () => {
  it('never constructs the outbound transport when the flag is off', async () => {
    vi.stubEnv('CALENDAR_WRITE_NOTICE_ENABLED', '');
    const makeTransport = vi.fn();
    const placement = withCalendarWriteNotice(
      fakePlacement(),
      productionCalendarWriteNoticePorts({} as Database, makeTransport as never),
    );
    expect(await placement.sync(REQUEST)).toEqual(WRITTEN);
    expect(makeTransport).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
