import { describe, expect, it } from 'vitest';
import {
  calendarSavePlace,
  claimSaveConfirmation,
  suppressDuplicateSaveConfirmation,
} from './calendar-save';

const SATURDAY = '2026-11-07T13:00:00.000Z';

describe('calendarSavePlace', () => {
  it('names Hale’s family calendar when no ICS was delivered', () => {
    expect(calendarSavePlace({ icsDelivered: false })).toBe('hale_family_calendar');
  });

  it('names the ICS when that is what was delivered', () => {
    expect(calendarSavePlace({ icsDelivered: true })).toBe('ics');
  });
});

describe('claimSaveConfirmation', () => {
  const open = [{ title: "Ava's carpool", startsAt: SATURDAY }];

  it('lets the first confirmation for a save stand', () => {
    expect(claimSaveConfirmation([], { title: "Ava's carpool", startsAt: SATURDAY })).toBe('first');
  });

  it('treats the same title and a minute-off clock as the same save', () => {
    expect(
      claimSaveConfirmation(open, {
        title: "  ava's carpool ",
        startsAt: '2026-11-07T13:01:00.000Z',
      }),
    ).toBe('duplicate');
  });

  it('treats a different day as a different save', () => {
    expect(
      claimSaveConfirmation(open, {
        title: "Ava's carpool",
        startsAt: '2026-11-08T13:00:00.000Z',
      }),
    ).toBe('first');
  });

  it('treats a different occasion at the same time as a different save', () => {
    expect(claimSaveConfirmation(open, { title: 'Piano', startsAt: SATURDAY })).toBe('first');
  });
});

describe('suppressDuplicateSaveConfirmation', () => {
  it('sends nothing when this turn only repeated a confirmation', () => {
    expect(suppressDuplicateSaveConfirmation({ alreadyConfirming: true, newDrafts: 0 })).toBe(true);
  });

  it('still speaks when this turn drafted a new save', () => {
    expect(suppressDuplicateSaveConfirmation({ alreadyConfirming: true, newDrafts: 1 })).toBe(
      false,
    );
  });

  it('still speaks for the first confirmation', () => {
    expect(suppressDuplicateSaveConfirmation({ alreadyConfirming: false, newDrafts: 1 })).toBe(
      false,
    );
  });
});
