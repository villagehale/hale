import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchConnectorRequestSweep } from '~/lib/channel/connect/detect';
import type { HealthPlace } from '~/lib/channel/health-line';
import { matchBothFreeAskSweep } from '~/lib/channel/linq/group-coparent-copy';
import { referralReply } from '~/lib/channel/off-domain/copy';
import { validateReplyCopySweep } from '~/lib/channel/reply-copy/validate';
import { apologyRefusals } from '~/lib/channel/router/apology';
import { MODEL_READ_SWEEP_ENABLED_ENV } from './flag';
import { setSharedMeaningScreen } from './read';
import { blankMeaningReading, unreadMeaningScreen } from './scripted-reader.fixture';

const ONTARIO: HealthPlace = { country: 'CA', provinceOrState: 'Ontario' };
const PROSE = {
  language: 'en',
  facts: ['soccer'],
  audience: 'direct' as const,
  questionAllowed: false,
  role: 'prose' as const,
};
const CLEAR_COPY = 'Nothing to do.';

afterEach(() => {
  vi.unstubAllEnvs();
  setSharedMeaningScreen(unreadMeaningScreen);
});

describe('MODEL_READ_SWEEP_ENABLED production gates', () => {
  it('unread fails closed: no connect claim, no both-free, no banned copy, no apology', async () => {
    vi.stubEnv(MODEL_READ_SWEEP_ENABLED_ENV, 'true');
    setSharedMeaningScreen(unreadMeaningScreen);

    expect(await matchConnectorRequestSweep('connect my Google Calendar')).toBeNull();
    expect(await matchBothFreeAskSweep('when are we both free')).toBe(false);
    expect(await validateReplyCopySweep(CLEAR_COPY, PROSE)).toBe('banned');
    expect(await apologyRefusals('That one broke on my end.')).toContain('promised_a_retry');
    expect(await referralReply('we need a family doctor', 'en', ONTARIO)).toBeNull();
  });

  it('a hit from the screen is what production uses, not the word list', async () => {
    vi.stubEnv(MODEL_READ_SWEEP_ENABLED_ENV, 'true');
    setSharedMeaningScreen({
      read: async (input) => {
        if (input.screen === 'connect_intent') {
          return blankMeaningReading({ hit: true, action: 'connect', provider: 'gmail' });
        }
        if (input.screen === 'copy_reply_banned') {
          return blankMeaningReading({ hit: false });
        }
        return blankMeaningReading({ hit: true });
      },
    });

    expect(await matchConnectorRequestSweep('please hook the inbox up')).toBe('gmail');
    expect(await validateReplyCopySweep(CLEAR_COPY, PROSE)).toBeNull();
  });
});
