import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_READ_SWEEP_ENABLED_ENV } from '~/lib/channel/meaning-screen/flag';
import type { MeaningScreenInput } from '~/lib/channel/meaning-screen/read';
import {
  blankMeaningReading,
  scriptedMeaningScreen,
} from '~/lib/channel/meaning-screen/scripted-reader.fixture';
import { queueActivityDecisionFromReply, readActivityDecision } from './activity-decision';

/**
 * Request mechanics only. The screen is scripted per test: what the model makes of a
 * parent's own words, in any language, is the meaning-screen eval (`activity_decision`
 * fixtures). There is no English or French pattern left to test here (VIL-723).
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readActivityDecision', () => {
  it('asks the activity_decision screen and keeps a complete pick or pass', async () => {
    const seen: MeaningScreenInput[] = [];
    const picked = scriptedMeaningScreen((input) => {
      seen.push(input);
      return blankMeaningReading({
        hit: true,
        decision: 'picked',
        activity: 'natation',
        kid: 'Maya',
        day: 'mardi',
        time: '16 h',
      });
    });
    expect(
      await readActivityDecision(picked, 'on prend la natation pour Maya, mardi 16 h'),
    ).toEqual({
      decision: 'picked',
      activity: 'natation',
      kid: 'Maya',
      day: 'mardi',
      time: '16 h',
    });
    expect(seen).toEqual([
      { screen: 'activity_decision', text: 'on prend la natation pour Maya, mardi 16 h' },
    ]);
    const passed = scriptedMeaningScreen(() =>
      blankMeaningReading({ hit: true, decision: 'passed', activity: '美术', kid: 'Maya' }),
    );
    expect(await readActivityDecision(passed, '美术课玛雅就不上了')).toEqual({
      decision: 'passed',
      activity: '美术',
      kid: 'Maya',
    });
  });

  it('is no decision when a pick lacks its day or time, or the screen read none', async () => {
    const noTime = scriptedMeaningScreen(() =>
      blankMeaningReading({
        hit: true,
        decision: 'picked',
        activity: 'swim',
        kid: 'Maya',
        day: 'Tue',
      }),
    );
    expect(await readActivityDecision(noTime, 'swim for Maya on Tuesday')).toBeNull();
    const none = scriptedMeaningScreen(() => blankMeaningReading({ decision: 'none' }));
    expect(await readActivityDecision(none, 'we got in to swim!')).toBeNull();
  });

  it('names an unread screen', async () => {
    const unread = scriptedMeaningScreen(() => null);
    expect(await readActivityDecision(unread, 'picked swim for Maya, Tuesday at 4')).toBe('unread');
  });
});

describe('queueActivityDecisionFromReply with the sweep off', () => {
  it('reads nothing, touches no table, and names why nothing was queued', async () => {
    const database = new Proxy({} as never, {
      get() {
        throw new Error('the sweep is off: no read');
      },
    });
    const screen = scriptedMeaningScreen(() => {
      throw new Error('the sweep is off: no model read');
    });
    const queue = () =>
      queueActivityDecisionFromReply(database, {
        familyId: '11111111-1111-4111-8111-111111111111',
        parentUserId: '22222222-2222-4222-8222-222222222222',
        originChatId: 'chat-1to1',
        body: 'picked swim for Maya, Tuesday at 4:00',
        now: new Date('2026-11-20T15:00:00.000Z'),
        screen,
      });
    // Unset (the default), then the near misses that must stay off.
    expect(await queue()).toEqual({ status: 'skipped', reason: 'sweep_off' });
    for (const value of ['TRUE', 'true\n', 'on', '1']) {
      vi.stubEnv(MODEL_READ_SWEEP_ENABLED_ENV, value);
      expect(await queue()).toEqual({ status: 'skipped', reason: 'sweep_off' });
    }
  });
});
