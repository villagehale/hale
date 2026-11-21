import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';

const forceToolJson = vi.fn();
vi.mock('~/lib/pipeline/structured', () => ({
  forceToolJson: (...a: unknown[]) => forceToolJson(...a),
}));

// vitest.setup.ts already loaded the real module; load a fresh copy that sees the mock.
vi.resetModules();
const { createOptOutReader, optOutUserMessage } = await import('./opt-out-reader');

const TEXT = 'no reminder please';
const NONE = {
  value: { intent: 'none', verbatim: TEXT, language: 'en', confirmation: '' },
};
const pager = { page: async () => 'paged' as const };

async function requestFor(input: Parameters<typeof optOutUserMessage>[0]) {
  forceToolJson.mockResolvedValueOnce(NONE);
  await createOptOutReader({} as never, pager).read(input);
  return forceToolJson.mock.calls.at(-1)?.[0] as {
    system: string;
    systemExtras?: string[];
    userMessage: string;
  };
}

describe('VIL-742 the reader request for a party guest', () => {
  afterEach(() => {
    forceToolJson.mockReset();
  });

  it('every other sender gets the skill alone: no extra, and the same user bytes', async () => {
    const skill = await loadCronSkill('opt-out-read');
    const input = { text: TEXT, language: null, region: null };

    const request = await requestFor(input);

    expect(request.system).toBe(skill.instructions);
    expect(request).not.toHaveProperty('systemExtras');
    expect(request.userMessage).toBe(optOutUserMessage(input));
    expect(request.userMessage).not.toContain('party_guest');
  });

  it('a guest gets the addendum after the skill, and the fact in the user turn', async () => {
    const skill = await loadCronSkill('opt-out-read');
    const addendum = await loadCronSkill('opt-out-read-party-guest');

    const request = await requestFor({
      text: TEXT,
      language: null,
      region: null,
      partyGuest: true,
    });

    expect(request.system).toBe(skill.instructions);
    expect(request.systemExtras).toEqual([addendum.instructions]);
    expect(JSON.parse(request.userMessage).sender).toBe('party_guest');
  });

  it('the addendum tells the reader the reminder is all Hale sends this sender', async () => {
    const addendum = await loadCronSkill('opt-out-read-party-guest');

    expect(addendum.instructions).toContain('party_guest');
    expect(addendum.instructions).toMatch(/only thing Hale sends/i);
    expect(addendum.instructions).toMatch(/`stop`/);
    expect(addendum.instructions).toMatch(/`none`/);
  });
});
