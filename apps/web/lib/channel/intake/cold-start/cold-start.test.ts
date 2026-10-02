import { describe, expect, it, vi } from 'vitest';
import { DUTY_STOP_ASKING_KEY } from '~/lib/channel/coparent/duty/asks';
import { FIRST_TOUCH_GROUP_FR, FIRST_TOUCH_SMS_BY_LANGUAGE } from '../copy';
import {
  ASK_UNANSWERED_MS,
  ASK_WINDOW_MS,
  type AskLedgerRow,
  SHARED_STOP_ASKING_KEY,
  judgeAskBudget,
  localCalendarDay,
} from './budget';
import {
  DISCOVERY_NEXT_STEP,
  KNOWN_VENUE_HELLO,
  NAMES_ASK_BY_LANGUAGE,
  discoveryBubble,
  logisticsBubble,
  namesAsk,
  notedAfterLogistics,
  receiptLine,
  signupOffer,
  spokenAge,
  stopAskingReply,
  whatCanYouDo,
} from './copy';
import {
  coldStartCopyLocked,
  coldStartIntentClassifierEnabled,
  coldStartLadderEnabled,
} from './flags';
import { type ColdStartClassifier, judgeColdStartIntent, phraseIntent } from './intent';
import {
  activityFromFind,
  ageCorrectionFact,
  ageUpMonths,
  asksGender,
  calendarAskDue,
  kidFirstName,
  mentionsSchoolOrCamp,
} from './ladder';
import { planPull } from './pull';

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
    expect(coldStartCopyLocked(env)).toBe(false);
    expect(coldStartIntentClassifierEnabled(env)).toBe(false);
  });

  it('is on only for the exact string true', () => {
    const env = {
      COLD_START_LADDER_ENABLED: 'true',
      COLD_START_LADDER_COPY_LOCKED: 'true',
      COLD_START_INTENT_CLASSIFIER_ENABLED: 'true',
    };
    expect(coldStartLadderEnabled(env)).toBe(true);
    expect(coldStartCopyLocked(env)).toBe(true);
    expect(coldStartIntentClassifierEnabled(env)).toBe(true);
  });
});

describe('cold-start intent', () => {
  it('does not call the model for a CASL keyword', async () => {
    const classify = vi.fn();
    const judged = await judgeColdStartIntent({
      text: 'HELP',
      classifier: { classify },
      env: { COLD_START_INTENT_CLASSIFIER_ENABLED: 'true' },
    });
    expect(judged).toEqual({ intent: 'none', confidence: 'high', source: 'keyword' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('uses the phrase list when the classifier flag is off', async () => {
    const classify = vi.fn();
    expect(await judgeColdStartIntent({ text: 'set me up', classifier: { classify } })).toEqual({
      intent: 'set_me_up',
      confidence: 'high',
      source: 'phrase',
    });
    expect(phraseIntent("qu'est-ce que tu peux faire")).toBe('what_can_you_do');
    expect(phraseIntent('this is useless')).toBeNull();
    expect(phraseIntent('no swim')).toBeNull();
    expect(phraseIntent('help')).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it('counts stop asking from the model only at high confidence', async () => {
    const classifier = (confidence: 'high' | 'low' | 'ambiguous'): ColdStartClassifier => ({
      async classify() {
        return { intent: 'stop_asking', confidence };
      },
    });
    const env = { COLD_START_INTENT_CLASSIFIER_ENABLED: 'true' };
    expect(
      await judgeColdStartIntent({ text: 'please lay off', classifier: classifier('high'), env }),
    ).toMatchObject({ intent: 'stop_asking', source: 'model' });
    expect(
      await judgeColdStartIntent({ text: 'please lay off', classifier: classifier('low'), env }),
    ).toMatchObject({ intent: 'none', source: 'model' });
    expect(
      await judgeColdStartIntent({ text: 'useless', classifier: classifier('ambiguous'), env }),
    ).toMatchObject({ intent: 'stop_asking', source: 'phrase' });
  });
});

describe('ask budget', () => {
  it('shares the stop-asking fact key with duty asks', () => {
    expect(SHARED_STOP_ASKING_KEY).toBe(DUTY_STOP_ASKING_KEY);
  });

  it('allows four optional asks and counts a duty ask toward the cap and the day', () => {
    const duty = row({
      sendClass: 'duty_ask',
      askKey: 'duty-1',
      createdAt: START,
    });
    expect(
      judgeAskBudget(
        {
          now: START,
          familyStartedAt: START,
          rows: [duty],
          stopUntil: null,
          parentWroteSincePause: false,
        },
        { sendClass: 'logistics', askKey: 'logistics:swim' },
      ),
    ).toEqual({ allow: false, reason: 'ask_budget' });

    const nextDay = new Date(START.getTime() + 24 * 60 * 60 * 1000);
    const rows = [0, 1, 2, 3].map((index) =>
      row({
        askKey: `ask-${index}`,
        createdAt: new Date(START.getTime() + index * 24 * 60 * 60 * 1000),
        localDay: localCalendarDay(new Date(START.getTime() + index * 24 * 60 * 60 * 1000)),
      }),
    );
    expect(
      judgeAskBudget(
        {
          now: new Date(START.getTime() + 4 * 24 * 60 * 60 * 1000),
          familyStartedAt: START,
          rows,
          stopUntil: null,
          parentWroteSincePause: false,
        },
        { sendClass: 'calendar', askKey: 'calendar' },
      ),
    ).toEqual({ allow: false, reason: 'ask_budget' });
    expect(nextDay.getTime()).toBeGreaterThan(START.getTime());
  });

  it('treats a declined ask as final and pauses after two bad asks', () => {
    const declined = row({ askKey: 'logistics:swim', outcome: 'declined', createdAt: START });
    expect(
      judgeAskBudget(
        {
          now: new Date(START.getTime() + 2 * 24 * 60 * 60 * 1000),
          familyStartedAt: START,
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
          familyStartedAt: START,
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
          familyStartedAt: START,
          rows: [first, second],
          stopUntil: null,
          parentWroteSincePause: true,
        },
        { sendClass: 'names', askKey: 'names' },
      ).allow,
    ).toBe(true);
  });

  it('blocks on a 30-day stop and stops capping after day 7', () => {
    expect(
      judgeAskBudget(
        {
          now: START,
          familyStartedAt: START,
          rows: [],
          stopUntil: new Date(START.getTime() + 30 * 24 * 60 * 60 * 1000),
          parentWroteSincePause: false,
        },
        { sendClass: 'email', askKey: 'email' },
      ),
    ).toEqual({ allow: false, reason: 'stop_asking' });
    expect(
      judgeAskBudget(
        {
          now: new Date(START.getTime() + ASK_WINDOW_MS + 1000),
          familyStartedAt: START,
          rows: [0, 1, 2, 3].map((index) => row({ askKey: `old-${index}`, createdAt: START })),
          stopUntil: null,
          parentWroteSincePause: true,
        },
        { sendClass: 'calendar', askKey: 'calendar-later' },
      ),
    ).toEqual({ allow: true });
  });
});

describe('cold-start copy and ladder', () => {
  it('speaks the receipt the ticket names', () => {
    expect(spokenAge(48)).toBe('a 4-year-old');
    expect(spokenAge(18)).toBe('an 18-month-old');
    expect(receiptLine([48, 18], 'Markham')).toBe(
      'Got it: a 4-year-old and an 18-month-old, near Markham.',
    );
    const bubble = discoveryBubble({
      language: 'en',
      agesMonths: [48, 18],
      placeLabel: 'Markham',
      findBody: '1. Storytime (all ages) - Saturday',
    });
    expect(bubble.receipt).toBe('sent');
    expect(bubble.body).toContain(DISCOVERY_NEXT_STEP.en);
    expect(bubble.body).not.toMatch(/stop|unsubscribe/i);
  });

  it('does not let a placeholder leave, and does not ask gender', () => {
    expect(namesAsk('en', { COLD_START_LADDER_COPY_LOCKED: 'true' }).mayLeave).toBe(false);
    expect(NAMES_ASK_BY_LANGUAGE.en).toContain('TODO-Design');
    expect(signupOffer('date_known')).toEqual({ body: 'TODO-Design', mayLeave: false });
    expect(signupOffer('no_date').mayLeave).toBe(false);
    expect(asksGender(NAMES_ASK_BY_LANGUAGE.en)).toBe(false);
    expect(asksGender("Who's taking them Saturday to swim?")).toBe(false);
  });

  it('asks logistics in one question and keeps a first name only', () => {
    const solo = logisticsBubble({
      language: 'en',
      day: 'Saturday',
      activity: 'storytime',
      group: false,
      forwardLink: null,
    });
    expect(solo).toEqual({
      body: "Who's taking them Saturday to storytime? I'll note it.",
      forwardLink: 'not_offered',
    });
    const group = logisticsBubble({
      language: 'en',
      day: 'Saturday',
      activity: 'storytime',
      group: true,
      forwardLink: 'https://villagehale.com/join/abc',
    });
    expect(group.forwardLink).toBe('offered');
    expect(group.body).toContain("I'll keep track.");
    expect(group.body?.match(/\?/g)).toHaveLength(1);
    expect(notedAfterLogistics(false, 'en')).toBe("I'll note it. Text me if that changes.");
    expect(kidFirstName('Maya Chen')).toBe('Maya');
    expect(kidFirstName('Leo')).toBe('Leo');
    expect(activityFromFind('1. Storytime (all ages) - Saturday', '1')).toEqual({
      day: 'Saturday',
      activity: 'Storytime',
    });
  });

  it('ages a child forward, offers calendar without stacking, and pulls one step', () => {
    expect(
      ageUpMonths(18, new Date('2026-01-15T00:00:00.000Z'), new Date('2026-04-02T00:00:00.000Z')),
    ).toBe(21);
    expect(
      ageUpMonths(18, new Date('2026-04-02T00:00:00.000Z'), new Date('2026-01-15T00:00:00.000Z')),
    ).toBe(18);
    expect(mentionsSchoolOrCamp('Maya starts daycare in September')).toBe(true);
    expect(
      calendarAskDue({
        now: START,
        familyStartedAt: START,
        pickSettled: true,
        alreadyAsked: false,
      }),
    ).toBe(true);
    expect(
      calendarAskDue({
        now: START,
        familyStartedAt: START,
        pickSettled: true,
        alreadyAsked: true,
      }),
    ).toBe(false);
    const pulled = planPull({
      intent: 'what_can_you_do',
      language: 'en',
      hasPlace: true,
      hasAges: true,
      channel: 'sms',
      group: false,
      count: 3,
      place: 'Markham',
      ages: 'a 4-year-old',
    });
    expect(pulled.body).toBe(`3 things near Markham for a 4-year-old.\n${DISCOVERY_NEXT_STEP.en}`);
    expect(pulled.mayLeave).toBe(true);
    const later = planPull({
      intent: 'set_me_up',
      language: 'en',
      hasPlace: true,
      hasAges: true,
      channel: 'sms',
      group: false,
      count: 0,
      place: 'Markham',
      ages: 'a 4-year-old',
    });
    expect(later.mayLeave).toBe(false);
    expect(later.skipped).toBe('copy_unlocked');
    expect(later.body).toBe('TODO-Design');
    const groupFr = planPull({
      intent: 'set_me_up',
      language: 'fr',
      hasPlace: false,
      hasAges: false,
      channel: 'imessage',
      group: true,
      count: 0,
      place: '',
      ages: '',
    });
    expect(groupFr.body).toBe(FIRST_TOUCH_GROUP_FR);
    expect(groupFr.mayLeave).toBe(true);
    const groupEn = planPull({
      intent: 'set_me_up',
      language: 'en',
      hasPlace: false,
      hasAges: false,
      channel: 'sms',
      group: true,
      count: 0,
      place: '',
      ages: '',
    });
    expect(groupEn.body).toBe(FIRST_TOUCH_SMS_BY_LANGUAGE.en);
    expect(stopAskingReply('en')).not.toContain('?');
    expect(KNOWN_VENUE_HELLO.en).not.toMatch(/across the GTA|postal code/i);
    const fact = ageCorrectionFact({
      familyId: 'fam',
      childId: null,
      ageMonths: 60,
      now: START,
    });
    expect(fact.memoryKind).toBe('lasting');
    expect(fact.factValue).toMatchObject({ kind: 'age_correction', ageMonths: 60 });
  });

  it('keeps a next step on every line that can leave', () => {
    const lines = [
      discoveryBubble({
        language: 'en',
        agesMonths: [48],
        placeLabel: 'Markham',
        findBody: 'RADAR',
      }).body,
      logisticsBubble({
        language: 'en',
        day: 'Saturday',
        activity: 'swim',
        group: false,
        forwardLink: null,
      }).body,
      notedAfterLogistics(true, 'en'),
      whatCanYouDo({ language: 'en', count: 0, place: 'Markham', ages: 'a 4-year-old' }).body,
      whatCanYouDo({ language: 'en', count: 2, place: 'Markham', ages: 'a 4-year-old' }).body,
      stopAskingReply('en'),
      KNOWN_VENUE_HELLO.en,
      KNOWN_VENUE_HELLO.fr,
    ];
    for (const line of lines) {
      expect(line, line ?? '').toBeTruthy();
      expect(line).not.toMatch(/stop to unsubscribe|reply stop|désabonner/i);
      expect(line).toMatch(/[.?]/);
    }
  });
});
