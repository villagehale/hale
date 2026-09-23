import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE, withOptOut } from '~/lib/channel/opt-out';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { howItWentAsk } from './how-it-went-copy';

describe('how it went ask', () => {
  const en = howItWentAsk('swim');

  it('is the locked English sentence', () => {
    expect(en).toBe('How did swim go? One line is plenty.');
    expect(howItWentAsk('swim', 'en')).toBe(en);
    expect(isPrintableGsm7Basic(en)).toBe(true);
  });

  it('is the locked French twin, GSM-7 ASCII, with the space before the question mark', () => {
    const fr = howItWentAsk('swim', 'fr');
    expect(fr).toBe("Comment ca s'est passe pour swim ? Une ligne suffit.");
    expect(isPrintableGsm7Basic(fr)).toBe(true);
    expect((fr.match(/\?/g) ?? []).length).toBe(1);
    expect(smsSegments(`${fr}\n\n${OPT_OUT_LINE}`)).toBe(1);
    expect(smsSegments(withOptOut(fr, 'full'))).toBe(1);
  });
});
