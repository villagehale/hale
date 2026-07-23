import { describe, expect, it } from 'vitest';
import type { ReminderChild, ReminderEventView } from '~/lib/loop/templates/reminder/payload';
import {
  parseReminderVoiceAnswer,
  reminderVoiceContext,
  reminderVoiceFactSlots,
  reminderVoiceStrings,
} from './reminder-voice';

/**
 * The pure reminder-voice parse/validate + redacted-context seam (VIL-229). Quality
 * lives in the composeVoice/facts-lint unit tests + the cached-real eval; here we
 * prove the STRICT contract (a clean object parses, an extra field is rejected) and —
 * the privacy-critical piece for THIS template — that the context handed to the model
 * is the EXACT redacted view `eventDescriptor` renders (rule #1): a newborn's event
 * carries the leveled name, a teen's event is the bare generic, always, regardless of
 * the parent's name-level preference.
 */

const NOW = new Date('2026-07-24T12:00:00Z');
const TZ = 'America/Toronto';

const NEWBORN: ReminderChild = {
  id: 'c-newborn',
  name: 'Mira',
  dateOfBirth: '2026-01-15', // ~6 months old at NOW
  gender: 'girl',
};

const TEEN: ReminderChild = {
  id: 'c-teen',
  name: 'Rowan',
  dateOfBirth: '2011-03-01', // 15 years old at NOW
  gender: null,
};

function event(over: Partial<ReminderEventView> = {}): ReminderEventView {
  return {
    eventRef: 'e1',
    title: '6-month checkup', // no child name in the title — eventDescriptor prefixes it
    startsAt: '2026-07-24T14:00:00Z', // 10:00 EDT
    childId: 'c-newborn',
    sensitive: false,
    ...over,
  };
}

describe('reminderVoiceContext — rule #1: exactly the redacted view the template renders', () => {
  it('carries the leveled descriptor + time for a non-teen child at first_name level', () => {
    const ctx = reminderVoiceContext([event()], [NEWBORN], 'first_name', TZ, '-PT1H', NOW);
    expect(ctx).toEqual({
      offset: '-PT1H',
      events: [{ what: 'Mira — 6-month checkup', when: '10:00' }],
    });
  });

  it('never leaks a teen name — the bare generic, regardless of name-level preference', () => {
    const teenEvent = event({
      title: 'therapy session',
      childId: 'c-teen',
      startsAt: '2026-07-24T21:00:00Z', // 17:00 EDT
    });
    const ctx = reminderVoiceContext([teenEvent], [TEEN], 'first_name', TZ, '-P1D', NOW);
    expect(ctx).toEqual({
      offset: '-P1D',
      events: [{ what: 'an appointment', when: '5:00' }],
    });
    expect(JSON.stringify(ctx)).not.toContain('Rowan');
    expect(JSON.stringify(ctx)).not.toContain('therapy');
  });

  it('generic-flags a sensitive event even for a non-teen child', () => {
    const ctx = reminderVoiceContext(
      [event({ sensitive: true, title: 'a private matter' })],
      [NEWBORN],
      'first_name',
      TZ,
      '-PT1H',
      NOW,
    );
    expect(ctx.events[0]?.what).toBe('an appointment');
  });
});

describe('reminderVoiceFactSlots', () => {
  it('grounds on each event redacted descriptor + its time label', () => {
    const slots = reminderVoiceFactSlots([event()], [NEWBORN], 'first_name', TZ, NOW);
    expect(slots).toEqual(['Mira — 6-month checkup', '10:00']);
  });
});

describe('reminderVoiceStrings', () => {
  it('is the single voice line', () => {
    expect(reminderVoiceStrings({ line: 'a quick check-in this evening' })).toEqual([
      'a quick check-in this evening',
    ]);
  });
});

describe('parseReminderVoiceAnswer', () => {
  it('parses a clean voice object (line only)', () => {
    expect(parseReminderVoiceAnswer(JSON.stringify({ line: 'see you soon' }))).toEqual({
      line: 'see you soon',
    });
  });

  it('rejects an unknown/extra field (→ deterministic fallback)', () => {
    const answer = JSON.stringify({ line: 'see you soon', injectedFact: 'call 416-555-0000' });
    expect(parseReminderVoiceAnswer(answer)).toBeNull();
  });

  it('returns null for a missing field, non-JSON, and empty answer', () => {
    expect(parseReminderVoiceAnswer(JSON.stringify({}))).toBeNull();
    expect(parseReminderVoiceAnswer('no json here')).toBeNull();
    expect(parseReminderVoiceAnswer(null)).toBeNull();
  });
});
