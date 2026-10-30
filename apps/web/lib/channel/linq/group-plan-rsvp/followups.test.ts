import { describe, expect, it } from 'vitest';
import { followupBlockedByQuietHours, runGroupPlanFollowups } from './followups';
import { createMemoryGroupPlanRsvpStore, createMemoryWorld } from './memory-store';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

const CHAT = 'chat-soccer';
const AFTERNOON = new Date('2026-10-28T18:00:00.000Z'); // 14:00 Toronto
const NIGHT = new Date('2026-10-29T03:00:00.000Z'); // 23:00 Toronto

async function seededPlan(deadline: Date | null = new Date('2026-10-27T16:00:00.000Z')) {
  const world = createMemoryWorld();
  world.families.set(CHAT, { familyId: 'fam-1', timeZone: 'America/Toronto' });
  const store = createMemoryGroupPlanRsvpStore(world);
  const plan = await store.createPlan({
    chatId: CHAT,
    familyId: 'fam-1',
    title: 'soccer Saturday',
    startsAt: new Date('2026-11-01T15:00:00.000Z'),
    location: null,
    rsvpDeadlineAt: deadline,
    createdByUserId: null,
    expected: [
      { memberKey: 'k-a', displayName: 'Asha', userId: 'u-a', haleCustomer: true },
      { memberKey: 'k-b', displayName: 'Ben', userId: null, haleCustomer: false },
    ],
    now: AFTERNOON,
  });
  await store.upsertRsvp({
    planId: plan.id,
    memberKey: 'k-a',
    displayName: 'Asha',
    householdLabel: null,
    userId: 'u-a',
    haleCustomer: true,
    response: 'yes',
    headcount: 1,
    source: 'text',
    coversKeys: [],
    verbatim: 'yes',
    now: AFTERNOON,
  });
  return { world, store, plan };
}

describe('followupBlockedByQuietHours', () => {
  it('blocks a night-time nudge in the covering family zone', () => {
    expect(followupBlockedByQuietHours(NIGHT, 'America/Toronto')).toBe(true);
    expect(followupBlockedByQuietHours(AFTERNOON, 'America/Toronto')).toBe(false);
  });
});

describe('runGroupPlanFollowups', () => {
  it('sends one nudge naming who is waiting, then dedupes the next tick', async () => {
    const { store } = await seededPlan();
    const texts: string[] = [];
    const composer = fakeGroupPlanRsvpComposer();
    const first = await runGroupPlanFollowups(
      {
        store,
        composer,
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: `msg-${texts.length}` };
        },
        enabled: () => true,
      },
      AFTERNOON,
    );
    expect(first.sent).toBe(1);
    expect(first.deduped).toBe(0);
    expect(texts).toHaveLength(1);
    expect(composer.calls[0]?.input.kind).toBe('follow_up');
    expect(composer.calls[0]?.input.facts.title).toBe('soccer Saturday');
    expect(composer.calls[0]?.input.facts.waitingNames).toEqual(['Ben']);
    expect(composer.calls[0]?.input.questions).toBe(1);

    const second = await runGroupPlanFollowups(
      {
        store,
        composer,
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: `msg-${texts.length}` };
        },
        enabled: () => true,
      },
      AFTERNOON,
    );
    expect(second.sent).toBe(0);
    expect(second.evaluated).toBe(0);
    expect(texts.length).toBe(1);
  });

  it('claim-before-send drops a second runner on the same unsent wave', async () => {
    const { store, plan } = await seededPlan();
    const claimed = await store.claimFollowup(plan.id, 1, AFTERNOON);
    expect(claimed).toBe(true);
    const texts: string[] = [];
    const raced = await runGroupPlanFollowups(
      {
        store,
        composer: fakeGroupPlanRsvpComposer(),
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: 'x' };
        },
        enabled: () => true,
      },
      AFTERNOON,
    );
    expect(raced.sent).toBe(0);
    expect(raced.deduped).toBe(1);
    expect(texts).toEqual([]);
  });

  it('does not send during quiet hours and does not spend the claim', async () => {
    const { store } = await seededPlan();
    const texts: string[] = [];
    const night = await runGroupPlanFollowups(
      {
        store,
        composer: fakeGroupPlanRsvpComposer(),
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: 'x' };
        },
        enabled: () => true,
      },
      NIGHT,
    );
    expect(night.quietHours).toBe(1);
    expect(night.sent).toBe(0);
    expect(texts).toEqual([]);

    const later = await runGroupPlanFollowups(
      {
        store,
        composer: fakeGroupPlanRsvpComposer(),
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: 'x' };
        },
        enabled: () => true,
      },
      AFTERNOON,
    );
    expect(later.sent).toBe(1);
    expect(texts.length).toBe(1);
  });

  it('does not follow up before the deadline', async () => {
    const { store } = await seededPlan(new Date('2026-11-02T16:00:00.000Z'));
    const result = await runGroupPlanFollowups(
      {
        store,
        composer: fakeGroupPlanRsvpComposer(),
        send: async () => ({ providerMessageId: 'x' }),
        enabled: () => true,
      },
      AFTERNOON,
    );
    expect(result.evaluated).toBe(0);
    expect(result.sent).toBe(0);
  });
});
