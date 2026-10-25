import { describe, expect, it } from 'vitest';
import { howItWentAsk } from './how-it-went-copy';

describe('how it went ask', () => {
  it('is written for the activity, in the language asked', async () => {
    const en = await howItWentAsk('swim');
    expect(en).toBe('How did swim go? One line is plenty.');
    expect(await howItWentAsk('swim', 'en')).toBe(en);
    const fr = await howItWentAsk('swim', 'fr');
    expect(fr).toBe("Comment ca s'est passe pour swim ? Une ligne suffit.");
    expect(fr).not.toBe(en);
    expect((fr?.match(/\?/g) ?? []).length).toBe(1);
  });
});
