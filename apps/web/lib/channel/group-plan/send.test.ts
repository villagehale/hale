import type { Database } from '@hale/db';
import type { CalendarInviteReport, CalendarInviteRequest } from '@hale/worker/executor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type GroupPlan,
  type GroupPlanReportPorts,
  productionGroupPlanReportPorts,
  reportGroupPlan,
  withGroupPlanReport,
} from './send';

/**
 * VIL-443 (T17) 2/2 — the decorator on the executor's invite port. Every way it ends is a
 * named outcome; a group plan never also gets the 1:1 links; nothing canned is ever sent.
 * The composer is a port here, so no model runs (rule #8: the skill is judged in the eval).
 */

const REQUEST: CalendarInviteRequest = { familyId: 'f1', familyEventId: 'e1', method: 'REQUEST' };
const LINK = 'https://app.villagehale.com/api/ics/event/e1.c2ln';
const PLAN: GroupPlan = {
  familyId: 'f1',
  familyEventId: 'e1',
  placedByActionId: 'a1',
  chatId: 'chat-1',
  gateUserId: 'u-ana',
  change: 'added',
  dedupeKey: 'group_plan_calendar:e1:1',
  event: { title: 'Swim lesson', when: 'Sat, Nov 7, 10:00 AM', where: 'Y on Main' },
  members: [
    { userId: 'u-ana', firstName: 'Ana' },
    { userId: 'u-sam', firstName: 'Sam' },
  ],
  reachedUserIds: ['u-ana'],
  language: 'en',
};
const TEXT = `Swim is on Ana's calendar. Sam, add it here: ${LINK}`;

function ports(overrides: Partial<GroupPlanReportPorts> = {}): GroupPlanReportPorts {
  return {
    enabled: () => true,
    loadPlan: vi.fn(async () => PLAN),
    alreadySent: vi.fn(async () => false),
    gate: vi.fn(async () => ({ allowed: true, optOut: 'short' }) as const),
    mintLink: vi.fn(async () => LINK),
    compose: vi.fn(async () => TEXT),
    send: vi.fn(async () => 'sent' as const),
    unsent: vi.fn(async () => {}),
    ...overrides,
  };
}

function innerSender() {
  return {
    send: vi.fn(async (): Promise<CalendarInviteReport> => ({ status: 'reported', parents: [] })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('VIL-443 withGroupPlanReport', () => {
  it('is today’s 1:1 invite when the flag is off, without reading anything', async () => {
    const inner = innerSender();
    const p = ports({ enabled: () => false });
    expect(await withGroupPlanReport(inner, p).send(REQUEST)).toEqual({
      status: 'reported',
      parents: [],
    });
    expect(inner.send).toHaveBeenCalledWith(REQUEST);
    expect(p.loadPlan).not.toHaveBeenCalled();
  });

  it('is today’s 1:1 invite for a placement that is not a group plan', async () => {
    const inner = innerSender();
    const p = ports({ loadPlan: vi.fn(async () => null) });
    await withGroupPlanReport(inner, p).send(REQUEST);
    expect(inner.send).toHaveBeenCalledWith(REQUEST);
    expect(p.compose).not.toHaveBeenCalled();
  });

  it('reports a group plan to the group instead of 1:1, never both', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const inner = innerSender();
    const p = ports();
    expect(await withGroupPlanReport(inner, p).send(REQUEST)).toEqual({
      status: 'group_reported',
      outcome: 'sent',
    });
    expect(inner.send).not.toHaveBeenCalled();
    expect(p.send).toHaveBeenCalledWith(PLAN, TEXT, 'short');
  });

  it('names an unreadable placement and sends nothing anywhere', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const inner = innerSender();
    const p = ports({ loadPlan: vi.fn(async () => Promise.reject(new Error('db'))) });
    expect(await withGroupPlanReport(inner, p).send(REQUEST)).toEqual({
      status: 'errored',
      message: 'group_plan_unreadable',
    });
    expect(inner.send).not.toHaveBeenCalled();
    expect(p.send).not.toHaveBeenCalled();
  });
});

describe('VIL-443 reportGroupPlan', () => {
  it('hands the composer whose calendar it reached, who it is not on yet, and the link', async () => {
    const p = ports();
    expect(await reportGroupPlan(PLAN, p)).toBe('sent');
    expect(p.mintLink).toHaveBeenCalledWith('f1', 'e1');
    expect(p.compose).toHaveBeenCalledWith({
      change: 'added',
      event: PLAN.event,
      onCalendarOf: ['Ana'],
      notYet: ['Sam'],
      othersNotYet: 0,
      everyone: false,
      link: LINK,
      language: 'en',
    });
  });

  it('never sends twice for one revision', async () => {
    const p = ports({ alreadySent: vi.fn(async () => true) });
    expect(await reportGroupPlan(PLAN, p)).toBe('already_sent');
    expect(p.gate).not.toHaveBeenCalled();
    expect(p.compose).not.toHaveBeenCalled();
    expect(p.send).not.toHaveBeenCalled();
  });

  for (const reason of ['not_enrolled', 'quiet_hours', 'no_watch_consent'] as const) {
    it(`drops on ${reason}, before minting, composing or sending`, async () => {
      const p = ports({ gate: vi.fn(async () => ({ allowed: false, reason }) as const) });
      expect(await reportGroupPlan(PLAN, p)).toBe(`held:${reason}`);
      expect(p.mintLink).not.toHaveBeenCalled();
      expect(p.compose).not.toHaveBeenCalled();
      expect(p.send).not.toHaveBeenCalled();
    });
  }

  it('gates the primary parent at the injected clock', async () => {
    const now = new Date('2026-11-06T15:00:00.000Z');
    const p = ports({ now: () => now });
    await reportGroupPlan(PLAN, p);
    expect(p.gate).toHaveBeenCalledWith('f1', 'u-ana', now);
  });

  it('carries no link on a cancel and mints none', async () => {
    const p = ports();
    await reportGroupPlan({ ...PLAN, change: 'cancelled' }, p);
    expect(p.mintLink).not.toHaveBeenCalled();
    expect(p.compose).toHaveBeenCalledWith(
      expect.objectContaining({ change: 'cancelled', link: null, onCalendarOf: [], notYet: [] }),
    );
  });

  it('sends nothing canned when the text cannot be written, and records it', async () => {
    const p = ports({ compose: vi.fn(async () => null) });
    expect(await reportGroupPlan(PLAN, p)).toBe('unwritten');
    expect(p.unsent).toHaveBeenCalledWith(PLAN);
    expect(p.send).not.toHaveBeenCalled();
  });

  it('names a send that did not land', async () => {
    const p = ports({ send: vi.fn(async () => 'send_failed' as const) });
    expect(await reportGroupPlan(PLAN, p)).toBe('send_failed');
  });

  it('swallows a throw as a named outcome', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = ports({ mintLink: vi.fn(async () => Promise.reject(new Error('token'))) });
    expect(await reportGroupPlan(PLAN, p)).toBe('errored');
    expect(p.send).not.toHaveBeenCalled();
  });
});

describe('VIL-443 production ports', () => {
  it('reads nothing and leaves the 1:1 invite alone while the flag is off', async () => {
    vi.stubEnv('GROUP_PLAN_CALENDAR_REPORT_ENABLED', '');
    const inner = innerSender();
    const sender = withGroupPlanReport(inner, productionGroupPlanReportPorts({} as Database));
    expect(await sender.send(REQUEST)).toEqual({ status: 'reported', parents: [] });
    expect(inner.send).toHaveBeenCalledWith(REQUEST);
  });
});
