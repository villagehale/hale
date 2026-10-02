import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPARENT_DUTY_COPY_LOCKED_ENV,
  DUTY_CHANGE_NEXT_EN,
  DUTY_CHANGE_NEXT_FR,
  DUTY_NIGHT_BEFORE_COPY_EN,
  DUTY_NIGHT_BEFORE_COPY_FR,
  dutyCopyMayLeave,
  dutyOwnerEcho,
  dutyTitleMayBeSpoken,
} from './copy';
import {
  DUTY_BURDEN_ANSWER_FR,
  DUTY_BURDEN_ANSWER_TODO,
  DUTY_DEFAULT_OWNER_FR,
  DUTY_DEFAULT_OWNER_TODO,
  DUTY_LOPSIDED_CONSENT_FR,
  DUTY_LOPSIDED_CONSENT_TODO,
  DUTY_LOPSIDED_NUDGE_FR,
  DUTY_LOPSIDED_NUDGE_TODO,
  DUTY_PLACEHOLDER_COPY,
  DUTY_UNDO_TEXT_FR,
  DUTY_UNDO_TEXT_TODO,
  dutyBurdenAnswer,
  dutyDefaultOwnerText,
  dutyLopsidedConsentText,
  dutyLopsidedNudgeText,
  dutyUndoText,
} from './placeholders';
import { COPARENT_DUTY_MEMORY_ENABLED_ENV } from './flag';
import { dutyMayInitiateOneToOne } from './ack';
import { burdenAnswerText, burdenMayLeave, decideLopsidedNudge, lopsidedConsentCopy } from './burden';
import { readDutySyncDecision } from './sync-line';

afterEach(() => {
  vi.unstubAllEnvs();
});

const BANNED_SEND = /reply stop|unsubscribe/i;

describe('duty guardrails', () => {
  it('keeps the five group lines locked, and a token cannot leave', () => {
    expect(burdenMayLeave()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    vi.stubEnv('COPARENT_DUTY_BURDEN_SURFACE_ENABLED', 'true');
    expect(DUTY_UNDO_TEXT_TODO).toBe("Undone. Say so here if I've got it wrong.");
    expect(DUTY_UNDO_TEXT_FR).toBe("C'est annule. Dites-le ici si je me trompe.");
    expect(DUTY_BURDEN_ANSWER_TODO).toBe(
      "I don't keep score, but I can tell you what's still open this week. Want that?",
    );
    expect(DUTY_BURDEN_ANSWER_FR).toBe(
      'Je ne compte pas les points, mais je peux dire ce qui reste a faire cette semaine. Vous voulez?',
    );
    expect(DUTY_DEFAULT_OWNER_TODO).toBe(
      'Want {name} to be the usual for {event}? Yes or no is fine.',
    );
    expect(DUTY_DEFAULT_OWNER_FR).toBe(
      'Vous voulez que {name} soit la personne habituelle pour {event}? Oui ou non suffit.',
    );
    expect(DUTY_LOPSIDED_CONSENT_TODO).toBe(
      'Want me to say something if the load gets uneven for a while? Yes or no is fine.',
    );
    expect(DUTY_LOPSIDED_CONSENT_FR).toBe(
      'Vous voulez que je vous le dise si la charge devient inegale pendant un moment? Oui ou non suffit.',
    );
    expect(DUTY_LOPSIDED_NUDGE_TODO).toBe(
      '{name}, want to take the open one: {event}, {day}? Yes or no is fine.',
    );
    expect(DUTY_LOPSIDED_NUDGE_FR).toBe(
      '{name}, tu veux prendre celle qui reste: {event}, {day}? Oui ou non suffit.',
    );
    expect(dutyUndoText('fr')).toBe(DUTY_UNDO_TEXT_FR);
    expect(dutyBurdenAnswer('en')).toBe(DUTY_BURDEN_ANSWER_TODO);
    expect(dutyDefaultOwnerText('en', 'Sam', 'swim')).toBe(
      'Want Sam to be the usual for swim? Yes or no is fine.',
    );
    expect(dutyDefaultOwnerText('fr', 'Sam', 'natation')).toBe(
      'Vous voulez que Sam soit la personne habituelle pour natation? Oui ou non suffit.',
    );
    expect(dutyLopsidedConsentText('fr')).toBe(DUTY_LOPSIDED_CONSENT_FR);
    expect(dutyLopsidedNudgeText('en', 'Sam', 'swim', 'Saturday')).toBe(
      'Sam, want to take the open one: swim, Saturday? Yes or no is fine.',
    );
    expect(dutyLopsidedNudgeText('fr', 'Sam', 'natation', 'samedi')).toBe(
      'Sam, tu veux prendre celle qui reste: natation, samedi? Oui ou non suffit.',
    );
    for (const line of DUTY_PLACEHOLDER_COPY) {
      expect(line).not.toContain('TODO-Design');
      expect(line).not.toMatch(BANNED_SEND);
      expect(line).toMatch(/^[\x20-\x7E]+$/);
      expect(line).not.toMatch(/\d/);
    }
    expect(dutyCopyMayLeave(DUTY_UNDO_TEXT_TODO)).toBe(true);
    expect(dutyCopyMayLeave(DUTY_BURDEN_ANSWER_TODO)).toBe(true);
    expect(dutyCopyMayLeave(DUTY_LOPSIDED_CONSENT_TODO)).toBe(true);
    expect(dutyCopyMayLeave(DUTY_DEFAULT_OWNER_TODO)).toBe(false);
    expect(dutyCopyMayLeave(DUTY_LOPSIDED_NUDGE_TODO)).toBe(false);
    expect(dutyCopyMayLeave(dutyDefaultOwnerText('en', 'Sam', 'swim'))).toBe(true);
    expect(burdenAnswerText().mayLeave).toBe(false);
    expect(burdenAnswerText().includesCounts).toBe(false);
    expect(burdenAnswerText().text).toBe(DUTY_BURDEN_ANSWER_TODO);
    expect(burdenMayLeave()).toBe(true);
    expect(lopsidedConsentCopy()).toBe(DUTY_LOPSIDED_CONSENT_TODO);
  });

  it('echoes only a locked kid-event owner line and ends on the locked next step', () => {
    expect(DUTY_NIGHT_BEFORE_COPY_EN.endsWith(DUTY_CHANGE_NEXT_EN)).toBe(true);
    expect(DUTY_NIGHT_BEFORE_COPY_FR.endsWith(DUTY_CHANGE_NEXT_FR)).toBe(true);
    expect(dutyTitleMayBeSpoken('Quarterly board review')).toBe(false);
    expect(dutyTitleMayBeSpoken('swim')).toBe(true);
    expect(dutyOwnerEcho('en', {
      name: 'Barton',
      kid: 'Maya',
      event: 'Quarterly board review',
      day: 'Saturday',
      time: '3:00pm',
    })).toBeNull();
    expect(
      dutyOwnerEcho('en', {
        name: 'Barton',
        kid: 'Maya',
        event: 'swim',
        day: 'Saturday',
        time: '3:00pm',
      }),
    ).toBeNull();

    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const line = dutyOwnerEcho('en', {
      name: 'Barton',
      kid: 'Maya',
      event: 'swim',
      day: 'Saturday',
      time: '3:00pm',
    });
    expect(line).toBe(
      "Barton has Maya's swim, Saturday at 3:00pm. Say so here if that changes.",
    );
    expect(line?.endsWith(DUTY_CHANGE_NEXT_EN)).toBe(true);
    expect(line).not.toMatch(BANNED_SEND);
    expect(line).not.toContain('\n');
  });

  it('does not read a non-kid 1:1 line as a duty decision', () => {
    expect(
      readDutySyncDecision("I'll take Maya's Quarterly board review, Saturday at 3:00pm"),
    ).toBeNull();
    expect(readDutySyncDecision("I'll take Maya's swim, Saturday at 3:00pm")).toEqual({
      decision: 'duty',
      activity: 'swim',
      kid: 'Maya',
      day: 'Saturday',
      time: '3:00pm',
    });
  });

  it('never opens a 1:1 and never writes Google Calendar', () => {
    expect(dutyMayInitiateOneToOne()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    expect(dutyMayInitiateOneToOne()).toBe(false);
    const source = readFileSync(new URL('./calendar.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('calendar-client');
    expect(source).not.toContain('googleapis');
  });

  it('keeps the lopsided nudge off, quiet, monthly, and number-free', () => {
    const open = {
      quiet: false,
      consent: 'granted' as const,
      lastSentAt: null,
      now: new Date('2026-09-24T15:00:00.000Z'),
      sample: 8,
      leaderShare: 0.8,
    };
    expect(decideLopsidedNudge(open).reason).toBe('flag_off');
    vi.stubEnv('COPARENT_DUTY_LOPSIDED_ENABLED', 'true');
    expect(decideLopsidedNudge({ ...open, quiet: true }).reason).toBe('quiet_hours');
    expect(decideLopsidedNudge({ ...open, consent: 'refused' }).reason).toBe('refused');
    expect(decideLopsidedNudge({ ...open, consent: 'unknown' }).reason).toBe('needs_consent');
    expect(decideLopsidedNudge({ ...open, sample: 2, leaderShare: 0.5 }).reason).toBe(
      'below_threshold',
    );
    expect(
      decideLopsidedNudge({
        ...open,
        lastSentAt: new Date('2026-09-14T15:00:00.000Z'),
      }).reason,
    ).toBe('monthly_cap');
    const ready = decideLopsidedNudge(open);
    expect(ready.send).toBe(false);
    expect(ready.text).toBeNull();
    expect(ready.reason).toBe('placeholder');
  });
});
