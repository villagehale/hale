import { describe, expect, it } from 'vitest';
import { scriptedSaidLine } from '~/lib/channel/voice/scripted-said-line.fixture';
import { IDENTITY_FACTS, identityChallengeReply } from './identity-challenge';

const identity = { intent: 'identity', confirmation: '' } as const;
const none = { intent: 'none', confirmation: '' } as const;

describe('identityChallengeReply · the turn reader decides, in any language (#868)', () => {
  it.each([
    ['en', 'who is this? how did you get my number'],
    ['zh', '你是谁？你怎么有我的电话号码？'],
    ['ar', 'من أنت؟ كيف حصلت على رقمي؟'],
  ])(
    '%s: an identity reading gets the model-written disclosure with the facts',
    async (_l, body) => {
      const reply = await identityChallengeReply(body, scriptedSaidLine(), identity);
      expect(reply.challenge).toBe(true);
      if (!reply.challenge) return;
      expect(reply.body).toContain(IDENTITY_FACTS.website);
      expect(reply.body).toContain(IDENTITY_FACTS.contactEmail);
    },
  );

  it('a non-identity reading is not a challenge, whatever the words', async () => {
    expect(await identityChallengeReply('who are you?', scriptedSaidLine(), none)).toEqual({
      challenge: false,
    });
  });

  it('no reading (reader down) is not a challenge: nothing is guessed from words', async () => {
    expect(await identityChallengeReply('who are you?', scriptedSaidLine(), null)).toEqual({
      challenge: false,
    });
  });

  it('a failed write sends nothing', async () => {
    const reply = await identityChallengeReply('你是谁？', { write: async () => null }, identity);
    expect(reply).toEqual({ challenge: true, body: null });
  });

  it('#919: how Hale has the number is a fact from the record, read only for a challenge', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const writer = {
      write: async (input: { facts: Record<string, unknown> }) => {
        seen.push(input.facts);
        return 'ok villagehale.com aloha@villagehale.com';
      },
    };
    let reads = 0;
    const origin = async () => {
      reads += 1;
      return { kind: 'added_by_family' as const, byName: 'Priya' };
    };
    await identityChallengeReply('hi', writer, none, origin);
    expect(reads).toBe(0);
    await identityChallengeReply('how did you get my number', writer, identity, origin);
    expect(reads).toBe(1);
    expect(seen[0]?.howWeGotYourNumber).toMatchObject({ who: 'Priya' });
    expect(seen[0]).not.toHaveProperty('stop');
  });

  it('#919: no record (or a failed read) hands no number fact, so nothing is guessed', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const writer = {
      write: async (input: { facts: Record<string, unknown> }) => {
        seen.push(input.facts);
        return 'ok villagehale.com aloha@villagehale.com';
      },
    };
    await identityChallengeReply('who is this', writer, identity, async () => null);
    await identityChallengeReply('who is this', writer, identity, async () => {
      throw new Error('db down');
    });
    expect(seen).toHaveLength(2);
    for (const facts of seen) expect(facts).not.toHaveProperty('howWeGotYourNumber');
  });
});
