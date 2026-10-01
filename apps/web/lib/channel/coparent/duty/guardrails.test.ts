import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPARENT_DUTY_COPY_LOCKED_ENV,
  DUTY_BURDEN_ANSWER_TODO,
  DUTY_CHANGE_NEXT_EN,
  DUTY_CHANGE_NEXT_FR,
  DUTY_DEFAULT_OWNER_TODO,
  DUTY_LOPSIDED_CONSENT_TODO,
  DUTY_LOPSIDED_NUDGE_TODO,
  DUTY_NIGHT_BEFORE_COPY_EN,
  DUTY_NIGHT_BEFORE_COPY_FR,
  DUTY_PLACEHOLDER_COPY,
  DUTY_UNDO_TEXT_TODO,
  dutyCopyMayLeave,
  dutyOwnerEcho,
  dutyTitleMayBeSpoken,
} from './copy';
import { COPARENT_DUTY_MEMORY_ENABLED_ENV } from './flag';
import { dutyMayInitiateOneToOne } from './ack';
import { burdenAnswerText, burdenMayLeave, decideLopsidedNudge, lopsidedConsentCopy } from './burden';
import { readDutySyncDecision } from './sync-line';

afterEach(() => {
  vi.unstubAllEnvs();
});

const BANNED_SEND = /reply stop|unsubscribe/i;

describe('duty guardrails', () => {
  it('keeps new parent-visible strings as design placeholders that cannot leave', () => {
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    vi.stubEnv('COPARENT_DUTY_BURDEN_SURFACE_ENABLED', 'true');
    for (const line of DUTY_PLACEHOLDER_COPY) {
      expect(line).toContain('TODO-Design');
      expect(line).not.toMatch(BANNED_SEND);
      expect(dutyCopyMayLeave(line)).toBe(false);
    }
    expect(DUTY_UNDO_TEXT_TODO).toMatch(/say so/i);
    expect(DUTY_BURDEN_ANSWER_TODO).toMatch(/\?/);
    expect(DUTY_DEFAULT_OWNER_TODO).toMatch(/say yes or no/i);
    expect(DUTY_LOPSIDED_CONSENT_TODO).toMatch(/say yes or no/i);
    expect(DUTY_LOPSIDED_NUDGE_TODO).toMatch(/say yes or no/i);
    expect(DUTY_LOPSIDED_NUDGE_TODO).not.toMatch(/\d/);
    expect(DUTY_DEFAULT_OWNER_TODO).not.toMatch(/\d/);
    expect(burdenAnswerText().mayLeave).toBe(false);
    expect(burdenAnswerText().includesCounts).toBe(false);
    expect(burdenMayLeave()).toBe(false);
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
