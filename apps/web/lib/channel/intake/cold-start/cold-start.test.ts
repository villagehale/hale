import { describe, expect, it } from 'vitest';
import { DUTY_STOP_ASKING_KEY } from '~/lib/channel/coparent/duty/asks';
import {
  ASK_UNANSWERED_MS,
  type AskLedgerRow,
  SHARED_STOP_ASKING_KEY,
  judgeAskBudget,
  localCalendarDay,
} from './budget';
import { coldStartLadderEnabled } from './flags';

const START = new Date('2026-07-01T16:00:00.000Z');

function row(
  partial: Partial<AskLedgerRow> & Pick<AskLedgerRow, 'askKey' | 'createdAt'>,
): AskLedgerRow {
  return {
    sendClass: 'logistics',
    outcome: 'sent',
    localDay: localCalendarDay(partial.createdAt),
    ...partial,
  };
}

describe('cold-start flags', () => {
  it.each(['', 'TRUE', 'true\n', 'on', '1'])('stays off for %j', (value) => {
    const env = {
      COLD_START_LADDER_ENABLED: value,
      COLD_START_LADDER_COPY_LOCKED: value,
      COLD_START_INTENT_CLASSIFIER_ENABLED: value,
    };
    expect(coldStartLadderEnabled(env)).toBe(false);
  });

  it('is on only for the exact string true', () => {
    const env = {
      COLD_START_LADDER_ENABLED: 'true',
      COLD_START_LADDER_COPY_LOCKED: 'true',
      COLD_START_INTENT_CLASSIFIER_ENABLED: 'true',
    };
    expect(coldStartLadderEnabled(env)).toBe(true);
  });
});

describe('ask budget', () => {
  it('shares the stop-asking fact key with duty asks', () => {
    expect(SHARED_STOP_ASKING_KEY).toBe(DUTY_STOP_ASKING_KEY);
  });

  it('treats a declined ask as final and pauses after two bad asks', () => {
    const declined = row({ askKey: 'logistics:swim', outcome: 'declined', createdAt: START });
    expect(
      judgeAskBudget(
        {
          now: new Date(START.getTime() + 2 * 24 * 60 * 60 * 1000),
          rows: [declined],
          stopUntil: null,
          parentWroteSincePause: false,
        },
        { sendClass: 'logistics', askKey: 'logistics:swim' },
      ),
    ).toEqual({ allow: false, reason: 'declined' });

    const first = row({
      askKey: 'a',
      outcome: 'declined',
      createdAt: START,
    });
    const second = row({
      askKey: 'b',
      outcome: 'sent',
      createdAt: new Date(START.getTime() + ASK_UNANSWERED_MS + 1000),
    });
    const later = new Date(second.createdAt.getTime() + ASK_UNANSWERED_MS + 1000);
    expect(
      judgeAskBudget(
        {
          now: later,
          rows: [first, second],
          stopUntil: null,
          parentWroteSincePause: false,
        },
        { sendClass: 'names', askKey: 'names' },
      ),
    ).toEqual({ allow: false, reason: 'paused' });
    expect(
      judgeAskBudget(
        {
          now: later,
          rows: [first, second],
          stopUntil: null,
          parentWroteSincePause: true,
        },
        { sendClass: 'names', askKey: 'names' },
      ).allow,
    ).toBe(true);
  });

  it('blocks on a 30-day stop', () => {
    expect(
      judgeAskBudget(
        {
          now: START,
          rows: [],
          stopUntil: new Date(START.getTime() + 30 * 24 * 60 * 60 * 1000),
          parentWroteSincePause: false,
        },
        { sendClass: 'email', askKey: 'email' },
      ),
    ).toEqual({ allow: false, reason: 'stop_asking' });
  });
});
