import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildCompanionView } from '~/lib/companion/queries';

/**
 * The health-reminder cron: for each family, find a child with a health item due
 * within the reminder window and not done, compose teen-safe copy (rule #1: a
 * child 13+ gets category-only, no name), and notify once per family per day. The
 * family selection, per-family companion load, and the notify caller are stubbed
 * so this asserts the SELECTION + COPY, not the send path (covered in callers.test).
 */

const selectFamiliesForRunMock = vi.fn();
const companionForFamilyMock = vi.fn();
const notifyHealthReminderMock = vi.fn();

vi.mock('./families', () => ({
  MAX_FAMILIES_PER_RUN: { digest: 100, discovery: 50, inference: 100, pushReminders: 100 },
  selectFamiliesForRun: (...a: unknown[]) => selectFamiliesForRunMock(...a),
  selectFamiliesNeedingDiscovery: vi.fn(),
}));
vi.mock('~/lib/companion/queries', () => ({
  companionForFamily: (...a: unknown[]) => companionForFamilyMock(...a),
}));
vi.mock('~/lib/push/callers', () => ({
  notifyFamilyHealthReminder: (...a: unknown[]) => notifyHealthReminderMock(...a),
}));

/** A companion view fixture with one health item at the given due/stage. */
function child(
  over: Partial<ChildCompanionView> & { id: string; stage: ChildCompanionView['stage'] },
  health: { dueInWeeks: number; done: boolean } | null,
): ChildCompanionView {
  const nextHealth = health
    ? [
        {
          key: `k-${over.id}`,
          ageMonths: 12,
          kind: 'well_child_visit' as const,
          what: '12-month well-baby visit',
          note: 'Confirm with your provider.',
          dueInWeeks: health.dueInWeeks,
          done: health.done,
        },
      ]
    : [];
  return {
    id: over.id,
    dateOfBirth: over.dateOfBirth ?? '2025-01-01',
    lastName: null,
    avatarUrl: null,
    stage: over.stage,
    ageMonths: over.ageMonths ?? 11,
    name: over.name ?? 'Nadia',
    nextHealth,
    todayHealth: nextHealth[0] ?? null,
    recentlyPassedHealth: [],
    milestones: [],
    whatsNow: [],
    whatsNext: '',
  } as ChildCompanionView;
}

beforeEach(() => {
  vi.resetModules();
  selectFamiliesForRunMock.mockReset();
  companionForFamilyMock.mockReset();
  notifyHealthReminderMock.mockReset().mockResolvedValue({ status: 'sent', notified: 1 });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPushRemindersCron', () => {
  it('notifies for a non-teen child with an item due within the window, using the first name', async () => {
    selectFamiliesForRunMock.mockResolvedValue(['fam-a']);
    companionForFamilyMock.mockResolvedValue([
      child({ id: 'c1', stage: 'toddler', name: 'Nadia' }, { dueInWeeks: 1, done: false }),
    ]);

    const { runPushRemindersCron } = await import('./push-reminders');
    const summary = await runPushRemindersCron({} as never);

    expect(summary.processed).toBe(1);
    expect(notifyHealthReminderMock).toHaveBeenCalledTimes(1);
    const [familyId, childId, message] = notifyHealthReminderMock.mock.calls[0] as [
      string,
      string,
      { title: string; body: string },
    ];
    expect(familyId).toBe('fam-a');
    expect(childId).toBe('c1');
    // First names ARE allowed to the family's own devices for a non-teen child.
    expect(message.body).toBe('A health item is coming up for Nadia');
  });

  it('uses category-only copy (no name) for a teen child (rule #1)', async () => {
    selectFamiliesForRunMock.mockResolvedValue(['fam-a']);
    companionForFamilyMock.mockResolvedValue([
      // A 13+ child: the view still carries the name — the copy gate alone must drop it.
      child({ id: 'teen', stage: 'teenager', name: 'Nadia', ageMonths: 168 }, { dueInWeeks: 0, done: false }),
    ]);

    const { runPushRemindersCron } = await import('./push-reminders');
    await runPushRemindersCron({} as never);

    expect(notifyHealthReminderMock).toHaveBeenCalledTimes(1);
    const [, , message] = notifyHealthReminderMock.mock.calls[0] as [
      string,
      string,
      { title: string; body: string },
    ];
    expect(message.body).toBe('A health item is coming up');
  });

  it('does NOT notify when the only due item is already done', async () => {
    selectFamiliesForRunMock.mockResolvedValue(['fam-a']);
    companionForFamilyMock.mockResolvedValue([
      child({ id: 'c1', stage: 'toddler' }, { dueInWeeks: 1, done: true }),
    ]);

    const { runPushRemindersCron } = await import('./push-reminders');
    await runPushRemindersCron({} as never);

    expect(notifyHealthReminderMock).not.toHaveBeenCalled();
  });

  it('does NOT notify when the soonest item is beyond the reminder window', async () => {
    selectFamiliesForRunMock.mockResolvedValue(['fam-a']);
    companionForFamilyMock.mockResolvedValue([
      child({ id: 'c1', stage: 'toddler' }, { dueInWeeks: 4, done: false }),
    ]);

    const { runPushRemindersCron } = await import('./push-reminders');
    await runPushRemindersCron({} as never);

    expect(notifyHealthReminderMock).not.toHaveBeenCalled();
  });

  it('does NOT notify for an item whose due date has already passed', async () => {
    selectFamiliesForRunMock.mockResolvedValue(['fam-a']);
    companionForFamilyMock.mockResolvedValue([
      child({ id: 'c1', stage: 'toddler' }, { dueInWeeks: -2, done: false }),
    ]);

    const { runPushRemindersCron } = await import('./push-reminders');
    await runPushRemindersCron({} as never);

    expect(notifyHealthReminderMock).not.toHaveBeenCalled();
  });

  it('records a per-family failure and continues the batch', async () => {
    selectFamiliesForRunMock.mockResolvedValue(['fam-a', 'fam-b']);
    companionForFamilyMock
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([child({ id: 'c1', stage: 'toddler' }, { dueInWeeks: 0, done: false })]);

    const { runPushRemindersCron } = await import('./push-reminders');
    const summary = await runPushRemindersCron({} as never);

    expect(summary.processed).toBe(2);
    expect(summary.results[0]).toEqual({ familyId: 'fam-a', error: 'db down' });
    expect(notifyHealthReminderMock).toHaveBeenCalledTimes(1);
  });
});
