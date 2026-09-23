import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE, withOptOut } from '~/lib/channel/opt-out';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { EMPTY_SATURDAY_TEMPLATE_KEY, renderEmptySaturdayAsk } from './empty-saturday-copy';

describe('empty Saturday ask', () => {
  const body = renderEmptySaturdayAsk('Maya');

  it('is the locked English sentence, with a GSM-7 apostrophe', () => {
    expect(body).toBe(
      "This Saturday looks open for Maya. Want one nearby find that's actually running?",
    );
    expect(body).toContain("that's");
    expect(body.includes('\u2019')).toBe(false);
    expect(isPrintableGsm7Basic(body)).toBe(true);
  });

  it('asks one thing, names no weather, and fits one segment with the opt-out', () => {
    expect((body.match(/\?/g) ?? []).length).toBe(1);
    expect(body.toLowerCase()).not.toContain('forecast');
    expect(body.toLowerCase()).not.toContain('weather');
    expect(smsSegments(`${body}\n\n${OPT_OUT_LINE}`)).toBe(1);
    expect(smsSegments(withOptOut(body, 'full'))).toBe(1);
  });

  it('stamps the proactive nudge template the reader looks up', () => {
    expect(EMPTY_SATURDAY_TEMPLATE_KEY).toBe('proactive_nudge:empty_saturday');
  });
});
