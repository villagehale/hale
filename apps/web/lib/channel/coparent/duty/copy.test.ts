import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPARENT_DUTY_COPY_LOCKED_ENV,
  absorbDutyLine,
  dutyClockLabel,
  dutyCopyLocked,
  dutyCopyMayLeave,
  dutyKidChoices,
  dutyTitleMayBeSpoken,
  dutyWeekdayName,
  spokenFirstName,
} from './copy';

/**
 * copy.ts holds no sentence any more (VIL-413 / VIL-417): every duty line is the model's,
 * through duty-voice. What this file is the spec for is the FACTS code supplies — a
 * weekday as a word, a clock as a word, a first name a parent agreed to — and the lock a
 * duty bubble leaves under.
 */

describe('duty copy lock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays unlocked unless the value is exactly true', () => {
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, '');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'TRUE');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true\n');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    expect(dutyCopyLocked()).toBe(true);
  });

  it('lets nothing leave while the lane is dark, and no placeholder, token or booking claim ever', () => {
    expect(dutyCopyMayLeave('Sam has swim on Monday.')).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    expect(dutyCopyMayLeave('Sam has swim on Monday.')).toBe(true);
    expect(dutyCopyMayLeave('TODO-Design: which kid?')).toBe(false);
    expect(dutyCopyMayLeave('{name} has swim on Monday.')).toBe(false);
    expect(dutyCopyMayLeave('Sam is booked for swim.')).toBe(false);
    expect(dutyCopyMayLeave('   ')).toBe(false);
    expect(absorbDutyLine('This week: swim.', '{name} has swim.')).toBe('This week: swim.');
    expect(absorbDutyLine('This week: swim.', 'Sam is booked for swim.')).toBe('This week: swim.');
    expect(absorbDutyLine('Sunday.', 'Sam has swim on Monday.')).toBe(
      'Sunday.\nSam has swim on Monday.',
    );
  });

  it('holds no sentence: nothing in copy.ts is a template or a line a parent could read', () => {
    const copy = readFileSync(fileURLToPath(new URL('./copy.ts', import.meta.url)), 'utf8');
    const code = copy.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/\{(?:name|kid|event|day|time|list|kids|parentA|parentB)\}/);
    expect(code).not.toMatch(/Say so here|Who's taking|nobody yet|Who has what|Tomorrow:/);
    // The one placeholder marker left is the send guard's.
    expect(code.replace("text.includes('TODO-Design')", '')).not.toContain('TODO-Design');
  });
});

describe('the facts code supplies', () => {
  it('speaks only the first name a parent agreed to, never a phone', () => {
    expect(spokenFirstName('Sam Rivera')).toBe('Sam');
    expect(spokenFirstName('+14165550100')).toBeNull();
    expect(spokenFirstName('   ')).toBeNull();
    expect(spokenFirstName(null)).toBeNull();
  });

  it('offers a which-kid roster of two or more distinct first names, or nothing to ask', () => {
    expect(dutyKidChoices(['Maya', 'Leo'])).toEqual(['Maya', 'Leo']);
    expect(dutyKidChoices(['Maya Rivera', 'Maya R.', 'Leo'])).toEqual(['Maya', 'Leo']);
    expect(dutyKidChoices(['Maya'])).toBeNull();
    expect(dutyKidChoices([])).toBeNull();
  });

  it('gives the weekday and the clock as words in the household language', () => {
    const monday = new Date('2026-09-28T19:00:00.000Z');
    expect(dutyWeekdayName(monday, 'America/Toronto', 'en')).toBe('Monday');
    expect(dutyWeekdayName(monday, 'America/Toronto', 'fr')).toBe('lundi');
    expect(dutyClockLabel(monday, 'America/Toronto', 'en')).toBe('3:00pm');
    expect(dutyClockLabel(monday, 'America/Toronto', 'fr')).toBe('15:00');
    const midnight = new Date('2026-09-29T04:00:00.000Z');
    expect(dutyClockLabel(midnight, 'America/Toronto', 'en')).toBe('12:00am');
    expect(dutyClockLabel(midnight, 'America/Toronto', 'fr')).toBe('00:00');
  });

  it('speaks a kid-word title and not an adult one', () => {
    expect(dutyTitleMayBeSpoken('swim')).toBe(true);
    expect(dutyTitleMayBeSpoken('Quarterly board review')).toBe(false);
    expect(dutyTitleMayBeSpoken('')).toBeFalsy();
  });
});
