import { describe, expect, it } from 'vitest';
import { canaryCaptureExtras } from './canary-analytics';

describe('canaryCaptureExtras', () => {
  it('stamps the event and the person when the distinct id is a household', () => {
    expect(canaryCaptureExtras(true, 'a'.repeat(64))).toEqual({
      event: { canary: true },
      set: { canary: true },
    });
  });

  it('stamps the event only when the distinct id is shared by a route', () => {
    for (const distinctId of ['system', 'door:sms', 'door:imessage', 'lane:coach']) {
      expect(canaryCaptureExtras(true, distinctId)).toEqual({
        event: { canary: true },
        set: null,
      });
    }
  });

  it('adds nothing for a real household', () => {
    expect(canaryCaptureExtras(false, 'family-hash')).toEqual({ event: {}, set: null });
  });
});
