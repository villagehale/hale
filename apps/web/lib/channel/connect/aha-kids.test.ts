import { describe, expect, it } from 'vitest';
import { type KidContext, isKidRelated, kidRelatedAha } from './aha-kids';
import type { AhaSnapshot } from './aha-read';

/**
 * Hard rule (VIL-417): both wow moments are about the kids only. The filter
 * here is what stands between the parent's calendar or mailbox and the model.
 */

const FAMILY: KidContext = {
  childNames: ['Maya', 'Léo'],
  activityTitles: ['Swim at the rec centre', 'Story time at the library'],
};

function item(title: string, start: string, end: string, location: string | null = null) {
  return { title, start, end, allDay: false, location, declined: false };
}

function mail(subject: string, fromName: string | null = null, snippet: string | null = null) {
  return { subject, fromName, receivedAt: '2026-09-11T12:00:00.000Z', snippet };
}

describe('isKidRelated', () => {
  it("matches a child's name, with or without accents", () => {
    expect(isKidRelated('Maya dentist', FAMILY)).toBe(true);
    expect(isKidRelated('Leo soccer', FAMILY)).toBe(true);
    expect(isKidRelated('Pick up Léo', FAMILY)).toBe(true);
  });

  it('matches an activity Hale already found, by two shared words', () => {
    expect(isKidRelated('Swim lesson - rec centre', FAMILY)).toBe(true);
    expect(isKidRelated('Library story time', FAMILY)).toBe(true);
  });

  it('does not match a parent item on one shared word', () => {
    expect(isKidRelated('Centre Street parking', FAMILY)).toBe(false);
    expect(isKidRelated('Library card renewal', FAMILY)).toBe(true);
  });

  it('matches kid-activity vocabulary in both languages', () => {
    expect(isKidRelated('Camp registration closes Friday', FAMILY)).toBe(true);
    expect(isKidRelated('Inscription piscine', FAMILY)).toBe(true);
    expect(isKidRelated('Garderie: fermeture vendredi', FAMILY)).toBe(true);
  });

  it("leaves the parent's own work, money, and health alone", () => {
    for (const text of [
      'Team standup',
      'Budget review',
      'Dentist',
      'Your Amazon order has shipped',
      'Q3 planning deck',
      'Your lab results are ready',
      'Gym',
      'Registration renewal: vehicle',
      'Practice interview',
      'Spin class',
      '',
    ]) {
      expect(isKidRelated(text, FAMILY), text).toBe(false);
    }
  });
});

describe('kidRelatedAha', () => {
  it('keeps kid items and recomputes the clash from them alone', () => {
    const snapshot: AhaSnapshot = {
      provider: 'gcal',
      read: 'ok',
      calendar: [
        item('Swim at the rec centre', '2026-09-12T13:00:00.000Z', '2026-09-12T14:00:00.000Z'),
        item('Maya soccer', '2026-09-12T13:30:00.000Z', '2026-09-12T14:30:00.000Z'),
        item('Dentist', '2026-09-12T13:45:00.000Z', '2026-09-12T14:45:00.000Z'),
        item('Budget review', '2026-09-14T13:00:00.000Z', '2026-09-14T14:00:00.000Z'),
      ],
      email: [],
      overlaps: [
        { earlier: 'Swim at the rec centre', later: 'Maya soccer' },
        { earlier: 'Maya soccer', later: 'Dentist' },
      ],
    };
    const kept = kidRelatedAha(snapshot, FAMILY);
    expect(kept.read).toBe('ok');
    expect(kept.calendar.map((row) => row.title)).toEqual([
      'Swim at the rec centre',
      'Maya soccer',
    ]);
    expect(kept.overlaps).toEqual([{ earlier: 'Swim at the rec centre', later: 'Maya soccer' }]);
  });

  it('turns a parent-only calendar into none_for_kids with nothing to mention', () => {
    const snapshot: AhaSnapshot = {
      provider: 'gcal',
      read: 'ok',
      calendar: [
        item('Dentist', '2026-09-12T13:00:00.000Z', '2026-09-12T14:00:00.000Z'),
        item('Team standup', '2026-09-12T13:30:00.000Z', '2026-09-12T14:00:00.000Z'),
      ],
      email: [],
      overlaps: [{ earlier: 'Dentist', later: 'Team standup' }],
    };
    expect(kidRelatedAha(snapshot, FAMILY)).toEqual({
      provider: 'gcal',
      read: 'none_for_kids',
      calendar: [],
      email: [],
      overlaps: [],
    });
  });

  it('turns a parent-only mailbox into none_for_kids', () => {
    const snapshot: AhaSnapshot = {
      provider: 'gmail',
      read: 'ok',
      calendar: [],
      email: [
        mail('Your Amazon order has shipped', 'Amazon', 'Arriving Thursday.'),
        mail('Q3 planning deck', 'Priya', 'Comments by Friday.'),
      ],
      overlaps: [],
    };
    const kept = kidRelatedAha(snapshot, FAMILY);
    expect(kept.read).toBe('none_for_kids');
    expect(kept.email).toEqual([]);
  });

  it('keeps a kid mail by subject, sender or snippet', () => {
    const snapshot: AhaSnapshot = {
      provider: 'gmail',
      read: 'ok',
      calendar: [],
      email: [
        mail('Registration closes Friday', 'Camp Acorn', 'Spots are going fast.'),
        mail('Reminder', 'Rec centre', 'Maya is enrolled in Saturday swim.'),
        mail('Invoice 4471', 'Hydro', 'Your bill is ready.'),
      ],
      overlaps: [],
    };
    const kept = kidRelatedAha(snapshot, FAMILY);
    expect(kept.read).toBe('ok');
    expect(kept.email.map((row) => row.subject)).toEqual([
      'Registration closes Friday',
      'Reminder',
    ]);
  });

  it('leaves an empty, failed or withheld read as it was', () => {
    for (const read of ['empty', 'failed', 'withheld'] as const) {
      const snapshot: AhaSnapshot = {
        provider: 'gcal',
        read,
        calendar: [],
        email: [],
        overlaps: [],
      };
      expect(kidRelatedAha(snapshot, FAMILY)).toEqual(snapshot);
    }
  });
});
