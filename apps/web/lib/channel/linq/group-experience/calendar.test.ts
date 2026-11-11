import { describe, expect, it } from 'vitest';
import type { GroupPlan, GroupPlanCopyStore } from '../group-plan-invites';
import { placeYesFamilyCalendars } from './calendar';

const PLAN: GroupPlan = {
  groupPlanId: 'plan-1',
  chatId: 'chat-1',
  title: 'picnic',
  startsAt: new Date('2026-11-14T15:00:00.000Z'),
  endsAt: null,
  location: 'park',
  cancelled: false,
};

describe('placeYesFamilyCalendars', () => {
  it('writes a copy only for the yes families', async () => {
    const placed: string[] = [];
    const copies: GroupPlanCopyStore = {
      upsertCopy: async (_plan, familyId) => {
        placed.push(familyId);
        return { status: 'written', familyEventId: familyId };
      },
      cancelCopy: async () => null,
    };
    await placeYesFamilyCalendars(copies, PLAN, ['fam-yes']);
    expect(placed).toEqual(['fam-yes']);
  });

  it('writes nothing when nobody said yes', async () => {
    const placed: string[] = [];
    const copies: GroupPlanCopyStore = {
      upsertCopy: async (_plan, familyId) => {
        placed.push(familyId);
        return { status: 'written', familyEventId: familyId };
      },
      cancelCopy: async () => null,
    };
    await placeYesFamilyCalendars(copies, PLAN, []);
    expect(placed).toEqual([]);
  });
});
