import type {
  CalendarInviteReport,
  CalendarInviteRequest,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import { withInviteUnwrittenPage } from './calendar-invite-page';

/**
 * VIL-719 · the invite page decorator. The inner sender is a fake port returning a named
 * report; no model is involved. The report always comes back untouched, and only a deferral
 * that means the model could not write the words pages #ops, only while the policy is on.
 */

const REQUEST: CalendarInviteRequest = {
  familyId: 'fam-1',
  familyEventId: '44444444-4444-4444-8444-444444444444',
  method: 'REQUEST',
};

function harness(report: CalendarInviteReport) {
  const pages: OpsPage[] = [];
  const inner: CalendarInviteSender = { send: vi.fn(async () => report) };
  const wrapped = withInviteUnwrittenPage(inner, {
    page: async (page) => {
      pages.push(page);
      return 'paged';
    },
  });
  return { wrapped, inner, pages };
}

function deferred(reason: string): CalendarInviteReport {
  return {
    status: 'reported',
    parents: [
      { parentUserId: 'p1', channel: 'sms', outcome: 'sent' },
      { parentUserId: 'p2', channel: 'sms', outcome: 'compose_deferred', reason },
    ],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withInviteUnwrittenPage', () => {
  it.each(['client_unavailable', 'skill_unavailable', 'model_failed'])(
    'policy on: a %s deferral returns the report untouched and pages #ops once',
    async (reason) => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const report = deferred(reason);
      const { wrapped, inner, pages } = harness(report);
      expect(await wrapped.send(REQUEST)).toBe(report);
      expect(inner.send).toHaveBeenCalledWith(REQUEST);
      expect(pages).toEqual([
        {
          site: 'calendar_invite_unwritten',
          facts: { method: 'REQUEST', reason },
          ref: REQUEST.familyEventId,
        },
      ]);
    },
  );

  it.each(['time_unjudged', 'summary_too_long', 'summary_carries_destination', 'gate_exhausted'])(
    'policy on: a %s deferral is bad data, not a writer failure, and pages no one',
    async (reason) => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { wrapped, pages } = harness(deferred(reason));
      await wrapped.send(REQUEST);
      expect(pages).toEqual([]);
    },
  );

  it('policy on: every parent texted, or a report with no parent legs, pages no one', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    for (const report of [
      {
        status: 'reported',
        parents: [{ parentUserId: 'p1', channel: 'sms', outcome: 'sent' }],
      },
      { status: 'not_configured' },
      { status: 'group_reported', outcome: 'sent' },
    ] as CalendarInviteReport[]) {
      const { wrapped, pages } = harness(report);
      expect(await wrapped.send(REQUEST)).toBe(report);
      expect(pages).toEqual([]);
    }
  });

  it('policy off: a model failure pages no one, as before', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const report = deferred('model_failed');
    const { wrapped, pages } = harness(report);
    expect(await wrapped.send(REQUEST)).toBe(report);
    expect(pages).toEqual([]);
  });
});
