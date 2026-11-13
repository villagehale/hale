import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FamilyPrivateSlice } from '../multi-family';
import type { GroupExperienceReading } from './reading';
import type { GroupExperienceStore } from './store';
import { takeGroupExperienceTurn } from './turn';
import { fakeGroupExperienceComposer } from './voice-fake';

const CHAT = 'chat-exp';
const FAMILY = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-11T16:00:00.000Z');

function memoryStore(): GroupExperienceStore {
  const rows = new Map<
    string,
    {
      id: string;
      chatId: string;
      familyId: string;
      kind: 'rsvp_poll' | 'time_poll' | 'link_card' | 'mail_notice' | 'private_question';
      subjectKey: string;
      payload: Record<string, unknown>;
      closed: boolean;
    }
  >();
  let n = 0;
  return {
    async loadLive(chatId, kind) {
      return (
        [...rows.values()].find(
          (row) => row.chatId === chatId && row.kind === kind && !row.closed,
        ) ?? null
      );
    },
    async loadLiveBySubject(chatId, kind, subjectKey) {
      return (
        [...rows.values()].find(
          (row) =>
            row.chatId === chatId &&
            row.kind === kind &&
            row.subjectKey === subjectKey &&
            !row.closed,
        ) ?? null
      );
    },
    async upsertLive(input) {
      const existing = await this.loadLiveBySubject(input.chatId, input.kind, input.subjectKey);
      if (existing) {
        existing.payload = input.payload;
        return existing;
      }
      const row = {
        id: `exp-${n++}`,
        chatId: input.chatId,
        familyId: input.familyId,
        kind: input.kind,
        subjectKey: input.subjectKey,
        payload: input.payload,
        closed: false,
      };
      rows.set(row.id, row);
      return row;
    },
    async patchPayload(id, payload) {
      const row = rows.get(id);
      if (row) row.payload = payload;
    },
    async close(id) {
      const row = rows.get(id);
      if (row) row.closed = true;
    },
  };
}

function stubPlans() {
  return {
    coveringFamily: async () => ({ familyId: FAMILY, timeZone: 'America/Toronto' }),
    loadLivePlan: async () => null,
    loadLivePoll: async () => null,
    createPlan: async (input: { chatId: string; familyId: string; title: string }) => ({
      id: 'plan-1',
      chatId: input.chatId,
      familyId: input.familyId,
      title: input.title,
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      expectedCount: 0,
    }),
    loadTally: async () => ({
      tally: {
        yesCount: 0,
        yesHeads: 0,
        yesNames: [],
        noCount: 0,
        noNames: [],
        maybeCount: 0,
        maybeHeads: 0,
        maybeNames: [],
        waitingCount: 0,
        waitingNames: [],
        toGo: 0,
      },
      rows: [],
      expected: [],
    }),
    upsertRsvp: async () => ({ edited: false }),
    addExpected: async () => undefined,
    seatedExpected: async () => [],
    claimFollowup: async () => false,
    markFollowupSent: async () => undefined,
    releaseFollowup: async () => undefined,
    listDueFollowups: async () => [],
  } as never;
}

function reading(partial: Partial<GroupExperienceReading>): GroupExperienceReading {
  return {
    kind: 'none',
    title: null,
    samePlan: null,
    response: null,
    optionKey: null,
    options: [],
    starts: [],
    confidence: 'high',
    ...partial,
  };
}

describe('takeGroupExperienceTurn', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does nothing while every new flag is off', async () => {
    const result = await takeGroupExperienceTurn(
      {
        chatId: CHAT,
        familyId: FAMILY,
        senderHandle: '+15555550111',
        senderUserId: null,
        senderName: 'Priya',
        senderFamilyId: FAMILY,
        text: 'who is in for Saturday',
        messageId: 'm-1',
        language: 'en',
        timeZone: 'America/Toronto',
        now: NOW,
      },
      {
        database: {} as never,
        reader: { read: async () => reading({ kind: 'rsvp_open', title: 'Saturday' }) },
        composer: fakeGroupExperienceComposer(),
        store: memoryStore(),
      },
    );
    expect(result).toEqual({ handled: false });
  });

  it('opens an RSVP in model-written words and skips the native card when LINQ_POLLS is off', async () => {
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
    const sent: string[] = [];
    const composer = fakeGroupExperienceComposer();
    const result = await takeGroupExperienceTurn(
      {
        chatId: CHAT,
        familyId: FAMILY,
        senderHandle: '+15555550111',
        senderUserId: 'user-1',
        senderName: 'Priya',
        senderFamilyId: FAMILY,
        text: 'who is in for the picnic',
        messageId: 'm-1',
        language: 'en',
        timeZone: 'America/Toronto',
        now: NOW,
      },
      {
        database: {} as never,
        reader: { read: async () => reading({ kind: 'rsvp_open', title: 'picnic' }) },
        composer,
        store: memoryStore(),
        plans: stubPlans(),
        pollCard: {
          enabled: () => false,
          send: async () => ({ status: 'skipped', reason: 'polls_off' }),
        },
        sendLine: async ({ text }) => {
          sent.push(text);
          return { providerMessageId: 'out-1' };
        },
        privateSlices: async () => [] as FamilyPrivateSlice[],
        deny: async () => [],
        households: async () => [FAMILY],
      },
    );
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.outcome).toBe('group_experience_spoken');
    expect(sent).toEqual(['rsvp_open?']);
    expect(result.card).toEqual({ skipped: 'polls_off' });
    expect(composer.calls[0]?.input.kind).toBe('rsvp_open');
  });

  it('sends nothing when the model cannot write the RSVP line', async () => {
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
    const sent: string[] = [];
    const result = await takeGroupExperienceTurn(
      {
        chatId: CHAT,
        familyId: FAMILY,
        senderHandle: '+15555550111',
        senderUserId: null,
        senderName: 'Priya',
        senderFamilyId: FAMILY,
        text: 'who is in',
        messageId: 'm-1',
        language: 'en',
        timeZone: 'America/Toronto',
        now: NOW,
      },
      {
        database: {} as never,
        reader: { read: async () => reading({ kind: 'rsvp_open', title: 'picnic' }) },
        composer: fakeGroupExperienceComposer({ fail: true }),
        store: memoryStore(),
        plans: stubPlans(),
        sendLine: async ({ text }) => {
          sent.push(text);
          return { providerMessageId: 'out-1' };
        },
        privateSlices: async () => [],
        deny: async () => [],
        households: async () => [FAMILY],
      },
    );
    expect(result).toMatchObject({
      handled: true,
      outcome: 'group_experience_line_unsent',
    });
    expect(sent).toEqual([]);
  });

  it('moves a private question out of the group and does not name the allergy there', async () => {
    vi.stubEnv('GROUP_PRIVATE_QUESTION_ENABLED', 'true');
    const group: string[] = [];
    const oneToOne: { familyId: string; text: string }[] = [];
    const result = await takeGroupExperienceTurn(
      {
        chatId: CHAT,
        familyId: FAMILY,
        senderHandle: '+15555550111',
        senderUserId: 'user-1',
        senderName: 'Priya',
        senderFamilyId: FAMILY,
        text: 'does the snack have peanuts? Mira is allergic',
        messageId: 'm-1',
        language: 'en',
        timeZone: 'America/Toronto',
        now: NOW,
      },
      {
        database: {} as never,
        reader: { read: async () => reading({ kind: 'private_question' }) },
        composer: fakeGroupExperienceComposer({
          body: (input) => (input.kind === 'private_hold' ? 'I will text you.' : 'Noted on Mira.'),
        }),
        store: memoryStore(),
        plans: stubPlans(),
        sendLine: async ({ text }) => {
          group.push(text);
          return { providerMessageId: 'g1' };
        },
        sendOneToOne: async (input) => {
          oneToOne.push({ familyId: input.familyId, text: input.text });
          return 'sent';
        },
        privateSlices: async () => [
          {
            familyId: FAMILY,
            memory: ['Mira peanut allergy'],
            calendar: [],
            email: [],
            children: ['Mira'],
            signups: [],
          },
        ],
        deny: async () => ['Mira peanut allergy'],
        households: async () => [FAMILY],
      },
    );
    expect(result).toMatchObject({ handled: true, outcome: 'group_experience_1to1' });
    expect(group).toEqual(['I will text you.']);
    expect(oneToOne).toEqual([{ familyId: FAMILY, text: 'Noted on Mira.' }]);
  });

  it('refuses a group line that repeats a deny-list term', async () => {
    vi.stubEnv('GROUP_PRIVATE_QUESTION_ENABLED', 'true');
    const group: string[] = [];
    await takeGroupExperienceTurn(
      {
        chatId: CHAT,
        familyId: FAMILY,
        senderHandle: '+15555550111',
        senderUserId: 'user-1',
        senderName: 'Priya',
        senderFamilyId: FAMILY,
        text: 'peanut allergy?',
        messageId: 'm-1',
        language: 'en',
        timeZone: 'America/Toronto',
        now: NOW,
      },
      {
        database: {} as never,
        reader: { read: async () => reading({ kind: 'private_question' }) },
        composer: fakeGroupExperienceComposer({ leak: 'About that peanut allergy.' }),
        store: memoryStore(),
        plans: stubPlans(),
        sendLine: async ({ text }) => {
          group.push(text);
          return { providerMessageId: 'g1' };
        },
        sendOneToOne: async () => 'sent',
        privateSlices: async () => [],
        deny: async () => ['peanut allergy'],
        households: async () => [FAMILY],
      },
    );
    expect(group).toEqual([]);
  });
});
