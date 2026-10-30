import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DutyCopyError,
  absorbDutyLine,
  dutyClockLabel,
  dutyCopyMayLeave,
  dutyLinePlan,
  dutyOwnerEcho,
  dutyWeekFacts,
  dutyWeekdayName,
  formatDutyKids,
  spokenFirstName,
} from './copy';

const OWNED = { name: 'Sam', kid: 'Maya', event: 'swim', day: 'Monday', time: '3:00pm' };

describe('duty lines — VIL-507 absolute zero fixed copy', () => {
  it('ships no sentence template in copy.ts, in any language', () => {
    const source = readFileSync(new URL('./copy.ts', import.meta.url), 'utf8');
    // No `{token}` skeletons and none of the old EN/FR sentences.
    expect(source).not.toMatch(/'[^'\n]*\{(name|kid|event|day|time|list|kids)\}[^'\n]*'/);
    expect(source).not.toMatch(/Who's taking it|Qui le prend|over to you|a toi de nous dire/);
  });

  it('plans facts, purpose and the ask budget — never words', () => {
    expect(dutyLinePlan('parent_initiated', OWNED)).toEqual({
      purpose: 'duty_owner',
      questionAllowed: false,
      facts: ['Sam', 'Maya', 'swim', 'Monday', '3:00pm'],
    });
    const { name: _n, ...unowned } = OWNED;
    expect(dutyLinePlan('parent_initiated', unowned)).toMatchObject({
      purpose: 'duty_parent_initiated',
      questionAllowed: true,
    });
    expect(
      dutyLinePlan('both_claimed', { event: 'swim', day: 'Monday', parentA: 'Sam', parentB: 'Ana' })
        .questionAllowed,
    ).toBe(true);
    expect(
      dutyLinePlan('silent_parent', { name: 'Ana', event: 'swim', day: 'Monday' }).questionAllowed,
    ).toBe(false);
  });

  it('refuses a missing fact or a booking claim instead of planning a line', () => {
    expect(() => dutyLinePlan('reask_48h', { kid: 'Maya', event: 'swim', day: 'Mon' })).toThrow(
      DutyCopyError,
    );
    expect(() => dutyLinePlan('which_kid', { name: 'Sam', kids: 'booked, Leo' })).toThrow(
      DutyCopyError,
    );
    expect(() => dutyLinePlan('night_before', OWNED)).toThrow(DutyCopyError);
  });

  it('owner echo is facts for the model, null for a non-kid title', () => {
    expect(dutyOwnerEcho('en', { ...OWNED, event: 'Quarterly board review' })).toBeNull();
    expect(dutyOwnerEcho('fr', OWNED)?.facts).toEqual(['Sam', 'Maya', 'swim', 'Monday', '3:00pm']);
  });

  it('builds week facts and the which-kid roster without inventing a name', () => {
    expect(
      dutyWeekFacts([
        { day: 'Monday', event: 'swim', name: 'Sam' },
        { day: 'Tuesday', event: 'piano', name: null },
      ]),
    ).toBe('Monday swim: Sam; Tuesday piano: unassigned');
    expect(formatDutyKids(['Maya', 'Leo'], 'en')).toBe('Maya, Leo, or both');
    expect(formatDutyKids(['Maya', 'Leo'], 'fr')).toBe('Maya, Leo, ou les deux');
    expect(formatDutyKids(['Maya'], 'en')).toBeNull();
    expect(spokenFirstName('Sam Rivera')).toBe('Sam');
    expect(spokenFirstName('+14165550100')).toBeNull();
  });

  it('keeps FR day and clock labels working', () => {
    const monday = new Date('2026-09-28T19:00:00.000Z');
    expect(dutyWeekdayName(monday, 'America/Toronto', 'fr')).toBe('lundi');
    expect(dutyClockLabel(monday, 'America/Toronto', 'fr')).toBe('15:00');
    expect(dutyClockLabel(monday, 'America/Toronto', 'en')).toBe('3:00pm');
  });

  it('send guard: no token, no booking claim, no empty line', () => {
    expect(dutyCopyMayLeave('Sam has it {day}')).toBe(false);
    expect(dutyCopyMayLeave('Maya is booked')).toBe(false);
    expect(dutyCopyMayLeave('  ')).toBe(false);
    expect(absorbDutyLine('Week.', 'Sam has swim {day}')).toBe('Week.');
  });
});
