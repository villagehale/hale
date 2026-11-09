import { describe, expect, it } from 'vitest';
import { carpoolLineUsable, fakeCarpoolComposer } from './carpool-voice';

describe('carpoolLineUsable', () => {
  it('accepts one question on an ask and none on a reminder', () => {
    expect(carpoolLineUsable('Who is driving Saturday soccer?', 'ask_driver')).toBe(true);
    expect(carpoolLineUsable('Maya has Saturday soccer at the rec', 'night_before_group')).toBe(
      true,
    );
  });

  it('rejects a URL or the wrong number of questions', () => {
    expect(carpoolLineUsable('Who is driving? See https://example.com', 'ask_driver')).toBe(false);
    expect(carpoolLineUsable('Who is driving Saturday?', 'night_before_group')).toBe(false);
    expect(carpoolLineUsable('Maya has it? Who else?', 'ask_driver')).toBe(false);
  });
});

describe('fakeCarpoolComposer', () => {
  it('repeats facts without calling a model', async () => {
    const voice = fakeCarpoolComposer();
    const line = await voice.compose({
      kind: 'night_before_group',
      facts: {
        driver: 'Priya',
        kids: 'Noah',
        pickupTime: 'Sat 8:00 a.m.',
        pickupPlace: 'the rec',
        event: 'soccer',
        language: 'en',
      },
    });
    expect(line).toContain('Priya');
    expect(voice.calls).toHaveLength(1);
  });
});
