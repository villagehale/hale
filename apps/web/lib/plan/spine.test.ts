import { describe, expect, it } from 'vitest';
import type { RoutineItemView } from '../village/mappers.js';
import type { AuthoredPlanView } from './authored.js';
import { buildPlanSpine, groupRoutineByDay, orderedWeekdays } from './spine.js';

const TZ = 'America/Toronto';
// Friday, 2026-07-03, mid-afternoon ET. The family's current week is Mon 2026-06-29
// (Monday) through Sun 2026-07-05.
const NOW = new Date('2026-07-03T18:00:00Z');

function plan(overrides: Partial<AuthoredPlanView> = {}): AuthoredPlanView {
  return {
    id: overrides.id ?? 'p',
    title: 'swim registration',
    notes: null,
    scheduledFor: null,
    completedAt: null,
    childId: null,
    childName: null,
    ...overrides,
  };
}

describe('buildPlanSpine — week window', () => {
  it('lays seven Mon–Sun columns anchored on the family-local Monday', () => {
    const { days } = buildPlanSpine([], NOW, TZ);
    expect(days.map((d) => d.weekday)).toEqual([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ]);
    // Monday of the week containing Fri Jul 3 is Mon Jun 29; Sunday is Jul 5.
    expect(days[0]?.dateKey).toBe('2026-06-29');
    expect(days[6]?.dateKey).toBe('2026-07-05');
  });
});

describe('buildPlanSpine — week-start preference', () => {
  it('rotates the spine to Sunday-first when weekStartDay is 0', () => {
    // Sunday of the week containing Fri Jul 3 is Sun Jun 28; Saturday is Jul 4.
    const { days } = buildPlanSpine([], NOW, TZ, 0);
    expect(days.map((d) => d.weekday)).toEqual([
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ]);
    expect(days[0]?.dateKey).toBe('2026-06-28');
    expect(days[6]?.dateKey).toBe('2026-07-04');
  });

  it('drops a dated plan onto its weekday in the Sunday-first order', () => {
    // Wednesday of this week is 2026-07-01, column index 3 in Sunday-first order.
    const wed = plan({ id: 'wed', scheduledFor: '2026-07-01T00:00:00.000Z' });
    const { days } = buildPlanSpine([wed], NOW, TZ, 0);
    expect(days[3]?.weekday).toBe('wednesday');
    expect(days[3]?.plans.map((p) => p.id)).toEqual(['wed']);
  });
});

describe('orderedWeekdays', () => {
  it('leaves Monday-first (weekStartDay 1) identical to WEEKDAYS', () => {
    expect(orderedWeekdays(1)).toEqual([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ]);
  });

  it('rotates to Sunday-first for weekStartDay 0', () => {
    expect(orderedWeekdays(0)).toEqual([
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ]);
  });
});

describe('buildPlanSpine — dated placement', () => {
  it('drops a dated in-week plan onto its own weekday column', () => {
    // Wednesday of this week is 2026-07-01 (stored UTC-midnight for a bare date).
    const wed = plan({ id: 'wed', scheduledFor: '2026-07-01T00:00:00.000Z' });
    const { days, undated, settled } = buildPlanSpine([wed], NOW, TZ);
    const wednesday = days.find((d) => d.weekday === 'wednesday');
    expect(wednesday?.plans.map((p) => p.id)).toEqual(['wed']);
    // It is not double-counted in the tail or the settled set.
    expect(undated).toHaveLength(0);
    expect(settled).toHaveLength(0);
    // Every other column stays empty.
    expect(days.filter((d) => d.plans.length > 0)).toHaveLength(1);
  });

  it('places a plan on the far edges of the week (Monday and Sunday) inclusively', () => {
    const mon = plan({ id: 'mon', scheduledFor: '2026-06-29T00:00:00.000Z' });
    const sun = plan({ id: 'sun', scheduledFor: '2026-07-05T00:00:00.000Z' });
    const { days } = buildPlanSpine([mon, sun], NOW, TZ);
    expect(days[0]?.plans.map((p) => p.id)).toEqual(['mon']);
    expect(days[6]?.plans.map((p) => p.id)).toEqual(['sun']);
  });
});

describe('buildPlanSpine — the undated tail', () => {
  it('sends an open plan with no scheduledFor to the tail, not any day column', () => {
    const loose = plan({ id: 'loose', scheduledFor: null });
    const { days, undated } = buildPlanSpine([loose], NOW, TZ);
    expect(undated.map((p) => p.id)).toEqual(['loose']);
    expect(days.every((d) => d.plans.length === 0)).toBe(true);
  });

  it('sends a plan dated in a FUTURE week to the tail so it is never dropped', () => {
    // Next Monday (2026-07-06) is outside this Mon–Sun window.
    const future = plan({ id: 'future', scheduledFor: '2026-07-06T00:00:00.000Z' });
    const { days, undated, settled } = buildPlanSpine([future], NOW, TZ);
    expect(undated.map((p) => p.id)).toEqual(['future']);
    expect(days.every((d) => d.plans.length === 0)).toBe(true);
    expect(settled).toHaveLength(0);
  });
});

describe('buildPlanSpine — settling', () => {
  it('settles a completed plan regardless of its date, off the spine', () => {
    const done = plan({
      id: 'done',
      scheduledFor: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-02T15:00:00.000Z',
    });
    const { days, undated, settled } = buildPlanSpine([done], NOW, TZ);
    expect(settled.map((p) => p.id)).toEqual(['done']);
    // A completed plan never shows on its weekday column or in the tail.
    expect(days.every((d) => d.plans.length === 0)).toBe(true);
    expect(undated).toHaveLength(0);
  });

  it('settles an open plan dated before this week (past-dated) rather than showing it', () => {
    // Last Friday, 2026-06-26, is before this week's Monday (2026-06-29).
    const past = plan({ id: 'past', scheduledFor: '2026-06-26T00:00:00.000Z' });
    const { days, undated, settled } = buildPlanSpine([past], NOW, TZ);
    expect(settled.map((p) => p.id)).toEqual(['past']);
    expect(days.every((d) => d.plans.length === 0)).toBe(true);
    expect(undated).toHaveLength(0);
  });
});

function routineItem(overrides: Partial<RoutineItemView> = {}): RoutineItemView {
  return { title: 't', kind: 'activity', stageNote: '', day: null, teenAttributed: false, ...overrides };
}

describe('groupRoutineByDay', () => {
  it('orders strips Monday→Sunday regardless of input order, with items kept per day', () => {
    const strips = groupRoutineByDay([
      routineItem({ title: 'sat', day: 'saturday' }),
      routineItem({ title: 'mon', day: 'monday' }),
      routineItem({ title: 'wed', day: 'wednesday' }),
    ]);
    expect(strips.map((s) => s.weekday)).toEqual(['monday', 'wednesday', 'saturday']);
    expect(strips[0]?.items.map((i) => i.title)).toEqual(['mon']);
  });

  it('collects same-day items into one strip in input order', () => {
    const strips = groupRoutineByDay([
      routineItem({ title: 'first', day: 'tuesday' }),
      routineItem({ title: 'second', day: 'tuesday' }),
    ]);
    expect(strips).toHaveLength(1);
    expect(strips[0]?.items.map((i) => i.title)).toEqual(['first', 'second']);
  });

  it('puts day-less (pre-day) items in a trailing null "anytime" strip after every weekday', () => {
    const strips = groupRoutineByDay([
      routineItem({ title: 'loose', day: null }),
      routineItem({ title: 'fri', day: 'friday' }),
    ]);
    expect(strips.map((s) => s.weekday)).toEqual(['friday', null]);
    expect(strips[1]?.items.map((i) => i.title)).toEqual(['loose']);
  });

  it('orders strips Sunday-first when weekStartDay is 0', () => {
    const strips = groupRoutineByDay(
      [
        routineItem({ title: 'mon', day: 'monday' }),
        routineItem({ title: 'sun', day: 'sunday' }),
      ],
      0,
    );
    expect(strips.map((s) => s.weekday)).toEqual(['sunday', 'monday']);
  });
});
