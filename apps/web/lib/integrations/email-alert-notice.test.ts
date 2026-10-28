import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SentinelClassification } from '~/lib/sentinel';
import { correlateExtraction } from '~/lib/sentinel/correlate';
import {
  EMAIL_ALERT_NOTICE_MAX_ATTEMPTS,
  type EmailAlertNoticeAnswer,
  type EmailAlertNoticeFacts,
  composeEmailAlertNotice,
  emailAlertNoticeFacts,
  emailAlertNoticeRefusals,
  offerMismatch,
  quietBeforeWriting,
  readEmailAlertNotice,
  senderLabel,
} from './email-alert-notice';

/**
 * The code half of the email-alert notice: the facts, the privacy cuts, the structural
 * refusals and how an answer is read. The words are the model's and are judged by the
 * cached eval (apps/worker/evals/run-email-alert-notice-eval.mjs), never asserted here.
 */

const NOW = new Date('2026-09-17T15:00:00.000Z');
const ROBIN = { id: 'child-robin', name: 'Robin', ageInMonths: 40 };

type Extraction = NonNullable<SentinelClassification['extraction']>;

function extraction(
  over: Partial<Omit<Extraction, 'event'>> & { event?: Partial<Extraction['event']> } = {},
) {
  const { event, ...rest } = over;
  return {
    kind: 'new_event',
    event: {
      title: 'Picture day',
      childRef: null,
      originalTime: null,
      newTime: '2026-10-02T13:00:00.000Z',
      location: 'the gym',
      ...event,
    },
    sourceConfidence: 0.9,
    quoteEvidence: 'Picture day is Friday',
    teenContent: false,
    teenAttributed: false,
    matchedEventRef: null,
    ...rest,
  } satisfies Extraction;
}

function facts(over: Partial<Parameters<typeof emailAlertNoticeFacts>[0]> = {}) {
  return emailAlertNoticeFacts({
    from: 'Maple Daycare <office@maple.example>',
    subject: 'Picture day next Friday',
    kind: 'new_event',
    extraction: extraction(),
    children: [ROBIN],
    fromParentsOwnCalendar: false,
    offer: 'add_to_week',
    otherHaleFamiliesGoing: null,
    language: 'en',
    timeZone: 'America/Toronto',
    now: NOW,
    ...over,
  });
}

function answer(over: Partial<EmailAlertNoticeAnswer> = {}): EmailAlertNoticeAnswer {
  return {
    reason: 'Robin’s daycare, a date',
    about_the_kids: 'yes',
    clear: true,
    text: 'Picture day at Maple is Friday at 9. Want me to add it to your week?',
    asks_to_add: true,
    ...over,
  };
}

describe('the Storytime duplicate, through the real correlator', () => {
  it('a reminder for an occasion already on the calendar is quiet before the writer', () => {
    const candidates = [
      {
        ref: { table: 'family_events' as const, id: 'evt-storytime' },
        title: 'Storytime at the library',
        startsAt: '2026-10-31T14:30:00.000Z',
      },
    ];
    const matchedEventRef = correlateExtraction(
      {
        kind: 'reminder_only',
        title: 'Storytime',
        originalTime: '2026-10-31T14:30:00.000Z',
        newTime: null,
      },
      candidates,
    );
    expect(matchedEventRef).toEqual({ table: 'family_events', id: 'evt-storytime' });
    expect(quietBeforeWriting({ kind: 'reminder_only', matchedEventRef })).toBe(
      'already_on_calendar',
    );
    // A reminder for something the family does not hold still reaches the writer.
    const unmatched = correlateExtraction(
      {
        kind: 'reminder_only',
        title: 'Bake sale',
        originalTime: '2026-10-31T14:30:00.000Z',
        newTime: null,
      },
      candidates,
    );
    expect(quietBeforeWriting({ kind: 'reminder_only', matchedEventRef: unmatched })).toBeNull();
  });
});

describe('quietBeforeWriting', () => {
  const matched = { table: 'family_events' as const, id: 'evt-1' };

  it('an unclear reading never reaches the writer', () => {
    expect(quietBeforeWriting({ kind: 'unclear', matchedEventRef: null })).toBe('unclear');
    expect(quietBeforeWriting({ kind: 'unclear', matchedEventRef: matched })).toBe('unclear');
  });

  it('matched and unchanged is already on the calendar, whatever the kind', () => {
    for (const kind of ['reminder_only', 'new_event', 'booking_confirmation'] as const) {
      expect(quietBeforeWriting({ kind, matchedEventRef: matched }), kind).toBe(
        'already_on_calendar',
      );
    }
  });

  it('a cancellation or a move of a matched event is the news, so the writer decides', () => {
    expect(quietBeforeWriting({ kind: 'cancellation', matchedEventRef: matched })).toBeNull();
    expect(quietBeforeWriting({ kind: 'reschedule', matchedEventRef: matched })).toBeNull();
  });

  it('an unmatched email goes to the writer', () => {
    for (const kind of [
      'cancellation',
      'reschedule',
      'new_event',
      'reminder_only',
      'booking_confirmation',
    ] as const) {
      expect(quietBeforeWriting({ kind, matchedEventRef: null }), kind).toBeNull();
    }
  });
});

describe('emailAlertNoticeFacts', () => {
  it('hands the writer the extraction, the children and the moment in the family’s zone', () => {
    expect(facts({ extraction: extraction({ event: { childRef: 'child-robin' } }) })).toEqual({
      now: { date: 'Thursday, September 17, 2026', time: '11:00 AM' },
      children: [{ name: 'Robin', ageYears: 3 }],
      email: {
        sender: 'Maple Daycare',
        subject: 'Picture day next Friday',
        kind: 'new_event',
        title: 'Picture day',
        namedChild: 'Robin',
        was: null,
        when: { date: 'Friday, October 2, 2026', time: '9:00 AM' },
        location: 'the gym',
      },
      fromParentsOwnCalendar: false,
      alreadyOnCalendar: false,
      offer: 'add_to_week',
      otherHaleFamiliesGoing: null,
      private: false,
      language: 'en',
    } satisfies EmailAlertNoticeFacts);
  });

  it('a 13+ child’s mail is category-only: no children, sender, subject, time, place, offer or count', () => {
    const hidden = facts({
      extraction: extraction({
        teenContent: true,
        event: { title: 'a message about school', childRef: 'child-robin' },
      }),
      otherHaleFamiliesGoing: 2,
    });
    expect(hidden.private).toBe(true);
    expect(hidden.children).toEqual([]);
    expect(hidden.offer).toBeNull();
    expect(hidden.otherHaleFamiliesGoing).toBeNull();
    expect(hidden.email).toEqual({
      sender: null,
      subject: null,
      kind: 'new_event',
      title: 'a message about school',
      namedChild: null,
      was: null,
      when: null,
      location: null,
    });
  });

  it('drops a time the model did not write as a date rather than guessing', () => {
    expect(
      facts({ extraction: extraction({ event: { newTime: 'next Friday' } }) }).email.when,
    ).toBe(null);
  });

  it('carries matched-ness so a cancellation of a held event is said as one', () => {
    const held = facts({
      kind: 'cancellation',
      offer: null,
      extraction: extraction({
        kind: 'cancellation',
        matchedEventRef: { table: 'family_events', id: 'evt-1' },
      }),
    });
    expect(held.alreadyOnCalendar).toBe(true);
  });
});

describe('senderLabel', () => {
  it('is the display name, or the bare domain — never the address', () => {
    expect(senderLabel('Maple Daycare <office@maple.example>')).toBe('Maple Daycare');
    expect(senderLabel('"Holade" <hello@holade.example>')).toBe('Holade');
    expect(senderLabel('noreply@recreation.example.ca')).toBe('recreation.example.ca');
    expect(senderLabel('"office@maple.example" <office@maple.example>')).toBe('maple.example');
  });
});

describe('emailAlertNoticeRefusals', () => {
  it('refuses only an empty text or a link, and nothing about wording or punctuation', () => {
    expect(emailAlertNoticeRefusals(answer().text)).toEqual([]);
    expect(emailAlertNoticeRefusals('Swim is off Saturday. Okay?')).toEqual([]);
    expect(emailAlertNoticeRefusals('  ')).toEqual(['empty']);
    // No length or segment cap: the model decides how long the text is.
    expect(emailAlertNoticeRefusals(`${'a'.repeat(1200)}?`)).toEqual([]);
    expect(emailAlertNoticeRefusals('See https://maple.example. Add it?')).toEqual(['link']);
    expect(emailAlertNoticeRefusals(`${'好'.repeat(150)}?`)).toEqual([]);
  });
});

describe('offerMismatch', () => {
  it('holds the model’s own asks_to_add to the offer row', () => {
    expect(offerMismatch(true, facts())).toEqual([]);
    expect(offerMismatch(false, facts({ offer: null }))).toEqual([]);
    expect(offerMismatch(false, facts())).toEqual(['offer_unasked']);
    expect(offerMismatch(true, facts({ offer: null }))).toEqual(['ask_without_offer']);
  });
});

describe('readEmailAlertNotice', () => {
  it('sends only a yes that is clear and passes the refusals', () => {
    expect(readEmailAlertNotice(answer(), facts())).toEqual({
      notice: { send: true, text: answer().text },
    });
  });

  it('a no or an unsure is not about the kids, whatever text came with it', () => {
    for (const about of ['no', 'unsure'] as const) {
      expect(readEmailAlertNotice(answer({ about_the_kids: about }), facts())).toEqual({
        notice: { send: false, why: 'not_about_the_kids' },
      });
    }
  });

  it('a yes that is not clear is unclear, whatever text came with it', () => {
    expect(readEmailAlertNotice(answer({ clear: false }), facts())).toEqual({
      notice: { send: false, why: 'unclear' },
    });
  });

  it('a refused draft is not a notice', () => {
    expect(readEmailAlertNotice(answer({ asks_to_add: false }), facts())).toEqual({
      refused: ['offer_unasked'],
    });
  });
});

describe('composeEmailAlertNotice', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a model that cannot be reached is nothing sent, after every attempt — no fallback', async () => {
    const create = vi.fn(async () => {
      throw new Error('overloaded');
    });
    const client = { messages: { create } } as unknown as AgentClient;

    await expect(composeEmailAlertNotice(client, facts(), 'fam-1')).resolves.toEqual({
      send: false,
      why: 'unwritten',
    });
    expect(create).toHaveBeenCalledTimes(EMAIL_ALERT_NOTICE_MAX_ATTEMPTS);
  });
});
