import { describe, expect, it } from 'vitest';
import {
  type ChildRef,
  type ExistingStamp,
  appendPassportLine,
  assignChild,
  canUndo,
  decideCalendar,
  decideGmail,
  groupVisible,
  nextStepOffer,
  planStampWrite,
  progressLabel,
  projectForGroup,
  sourceLabel,
  subjectSnippet,
} from './signals';

const NOW = new Date('2026-04-15T15:00:00Z');
const MIA: ChildRef = { id: 'mia', name: 'Mia', teenager: false };
const LEO: ChildRef = { id: 'leo', name: 'Leo', teenager: false };
const TEEN: ChildRef = { id: 'ava', name: 'Ava', teenager: true };

function gmail(overrides: Partial<Parameters<typeof decideGmail>[0]> = {}) {
  return decideGmail({
    subject: 'Registration confirmed: Little Dragons Karate, Fall session, 12 weeks',
    title: 'Little Dragons Karate',
    kind: 'booking_confirmation',
    connectedByUserId: 'sam',
    actorUserId: 'sam',
    teenAttributed: false,
    childRef: null,
    children: [MIA],
    now: NOW,
    ...overrides,
  });
}

describe('decideGmail', () => {
  it('stamps a multi-week registration and ignores the body', () => {
    const first = gmail({ body: 'please ignore this zoo ticket birthday party', childRef: 'mia' });
    const second = gmail({ body: 'a totally different body', snippet: 'snippet', childRef: 'mia' });
    expect(first).toEqual(second);
    expect(first.stamp).toBe(true);
    if (!first.stamp) return;
    expect(first.draft.kind).toBe('activity');
    expect(first.draft.activity).toBe('Little Dragons Karate');
    expect(first.draft.childId).toBe('mia');
    expect(first.draft.weeksTotal).toBe(12);
    expect(first.draft.seasonKey).toBe('fall-2026');
    expect(first.ask).toBe(true);
  });

  it('requires the mailbox to be connected by the actor', () => {
    expect(gmail({ connectedByUserId: null }).stamp).toBe(false);
    expect(gmail({ connectedByUserId: 'jordan', actorUserId: 'sam' })).toMatchObject({
      stamp: false,
      ask: false,
      reason: 'mailbox_not_self_connected',
    });
  });

  it('does not stamp a teenager, a one-off, or an unclear email', () => {
    expect(gmail({ teenAttributed: true })).toMatchObject({ reason: 'teen', ask: false });
    expect(
      gmail({
        subject: 'Tournament confirmation — spring showcase, 12 weeks',
        title: 'Soccer tournament',
      }),
    ).toMatchObject({ reason: 'one_off', ask: false });
    expect(gmail({ subject: 'Birthday party at the hall', title: 'Birthday party' })).toMatchObject(
      { reason: 'one_off', ask: false },
    );
    expect(gmail({ subject: 'Drop-in class Saturday', title: 'Drop-in soccer' })).toMatchObject({
      reason: 'one_off',
      ask: false,
    });
    expect(
      gmail({ subject: 'A note about the weekend', title: 'Hello', kind: 'other' }),
    ).toMatchObject({ reason: 'unclear', ask: false });
    expect(
      gmail({ subject: 'See you Tuesday', title: 'Practice', kind: 'booking_confirmation' }),
    ).toMatchObject({ reason: 'unclear', ask: false });
  });

  it('gives a one-time outing ticket the visit stamp', () => {
    const decision = gmail({
      subject: 'Your Toronto Zoo admission ticket',
      title: 'Toronto Zoo',
      childRef: 'mia',
    });
    expect(decision.stamp).toBe(true);
    if (!decision.stamp) return;
    expect(decision.draft.kind).toBe('outing');
    expect(decision.draft.activity).toBe('Toronto Zoo');
    expect(decision.draft.weeksTotal).toBeNull();
    expect(decision.draft.seasonKey.startsWith('visit-')).toBe(true);
  });

  it('assigns the only child when the email names nobody, and stays quiet otherwise', () => {
    const only = gmail();
    expect(only.stamp && only.draft.childId).toBe('mia');
    const many = gmail({ children: [MIA, LEO] });
    expect(many.stamp && many.draft.childId).toBeNull();
    expect(gmail({ childRef: 'nobody', children: [MIA, LEO] })).toMatchObject({
      reason: 'name_matches_none',
      ask: false,
    });
    expect(gmail({ children: [] })).toMatchObject({ reason: 'no_child', ask: false });
    expect(gmail({ children: [TEEN] })).toMatchObject({ reason: 'teen', ask: false });
  });

  it('keeps a subject snippet short and single-line', () => {
    expect(subjectSnippet('  Hello\nthere   friend  ')).toBe('Hello there friend');
    expect(subjectSnippet(` ${'a'.repeat(200)} `)?.length).toBe(180);
    expect(subjectSnippet('   ')).toBeNull();
  });
});

describe('decideCalendar', () => {
  const weekly = [0, 7, 14, 21].map((days) => new Date(Date.UTC(2026, 3, 7 + days, 22)));

  it('infers one enrollment from three weekly repeats', () => {
    const decision = decideCalendar({
      title: 'Soccer',
      occurrences: weekly,
      childRef: 'mia',
      teenAttributed: false,
      children: [MIA],
      now: NOW,
    });
    expect(decision.stamp).toBe(true);
    if (!decision.stamp) return;
    expect(decision.draft.weeksTotal).toBe(4);
    expect(decision.draft.activityKey).toBe('soccer');
    expect(decision.draft.kind).toBe('activity');
  });

  it('does not stamp two repeats, a monthly series, a one-off, or a week grain', () => {
    const base = {
      childRef: 'mia' as string | null,
      teenAttributed: false,
      children: [MIA],
      now: NOW,
    };
    expect(
      decideCalendar({ ...base, title: 'Soccer', occurrences: weekly.slice(0, 2) }),
    ).toMatchObject({ reason: 'below_floor' });
    const monthly = [0, 30, 60].map((days) => new Date(Date.UTC(2026, 0, 5 + days, 15)));
    expect(decideCalendar({ ...base, title: 'Soccer', occurrences: monthly })).toMatchObject({
      reason: 'not_weekly',
    });
    const sameWeek = [0, 2, 9, 16].map((days) => new Date(Date.UTC(2026, 3, 6 + days, 15)));
    expect(decideCalendar({ ...base, title: 'Soccer', occurrences: sameWeek })).toMatchObject({
      reason: 'not_weekly',
    });
    expect(decideCalendar({ ...base, title: 'Birthday party', occurrences: weekly })).toMatchObject(
      {
        reason: 'one_off',
      },
    );
    expect(decideCalendar({ ...base, title: 'Week 3', occurrences: weekly })).toMatchObject({
      reason: 'per_week_or_month',
    });
    expect(decideCalendar({ ...base, title: 'Busy', occurrences: weekly })).toMatchObject({
      reason: 'unclear',
    });
  });
});

describe('planStampWrite', () => {
  const live: ExistingStamp = {
    childId: 'mia',
    activityKey: 'soccer',
    seasonKey: 'spring-2026',
    sourceRef: 'gmail:1',
    sourceType: 'gmail',
    state: 'confirmed',
  };

  it('updates progress on the same stamp and never inserts another', () => {
    expect(
      planStampWrite([live], {
        childId: 'mia',
        activityKey: 'soccer',
        seasonKey: 'spring-2026',
        sourceRef: 'calendar:1',
        sourceType: 'calendar',
      }),
    ).toEqual({ action: 'skip', reason: 'email_owns_it' });
    expect(
      planStampWrite([live], {
        childId: 'mia',
        activityKey: 'soccer',
        seasonKey: 'spring-2026',
        sourceRef: 'gmail:1',
        sourceType: 'gmail',
      }),
    ).toEqual({ action: 'update_progress' });
  });

  it('treats a removed row as a tombstone', () => {
    const removed: ExistingStamp = { ...live, state: 'removed', sourceRef: 'gmail:old' };
    expect(
      planStampWrite([removed], {
        childId: 'mia',
        activityKey: 'soccer',
        seasonKey: 'spring-2026',
        sourceRef: 'gmail:new',
        sourceType: 'gmail',
      }),
    ).toEqual({ action: 'skip', reason: 'tombstone' });
  });
});

describe('progress, share, and the one line on an outbound', () => {
  it('shows season progress and not a per-week stamp', () => {
    expect(
      progressLabel({
        kind: 'activity',
        seasonLabel: 'Spring',
        weeksTotal: 12,
        weeksElapsed: 8,
        sessionStart: '2026-03-01',
        completed: false,
        now: NOW,
      }),
    ).toBe('Spring · 8 of 12 weeks');
    expect(
      progressLabel({
        kind: 'activity',
        seasonLabel: 'Spring',
        weeksTotal: 12,
        weeksElapsed: 0,
        sessionStart: '2026-05-01',
        completed: false,
        now: NOW,
      }),
    ).toBe('Spring');
    expect(
      progressLabel({
        kind: 'activity',
        seasonLabel: 'Spring',
        weeksTotal: 12,
        weeksElapsed: 12,
        sessionStart: '2026-03-01',
        completed: true,
        now: NOW,
      }),
    ).toBe('Spring · complete');
    expect(
      progressLabel({
        kind: 'outing',
        seasonLabel: 'AUG 25',
        weeksTotal: null,
        weeksElapsed: 0,
        sessionStart: '2025-08-17',
        completed: true,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('projects only a first name, an activity, and a season', () => {
    const stamp = {
      shared: true,
      state: 'confirmed' as const,
      activity: 'Soccer',
      seasonLabel: 'Spring 2026',
    };
    expect(projectForGroup(stamp, 'Mia Chen', false)).toEqual({
      childFirstName: 'Mia',
      activity: 'Soccer',
      season: 'Spring 2026',
    });
    expect(Object.keys(projectForGroup(stamp, 'Mia Chen', false) ?? {})).toEqual([
      'childFirstName',
      'activity',
      'season',
    ]);
    expect(groupVisible({ shared: false, state: 'confirmed' }, false)).toBe(false);
    expect(groupVisible({ shared: true, state: 'confirmed' }, false)).toBe(true);
    expect(groupVisible({ shared: false, state: 'confirmed' }, true)).toBe(true);
    expect(groupVisible({ shared: false, state: 'inferred' }, true)).toBe(false);
    expect(projectForGroup({ ...stamp, state: 'removed', shared: true }, 'Mia', true)).toBeNull();
  });

  it('names the source the way the sheet does', () => {
    expect(
      sourceLabel({
        sourceType: 'gmail',
        viewerIsOwner: true,
        ownerFirstName: 'Sam',
        sharerFirstName: null,
        toldOn: null,
      }),
    ).toBe('Seen in your Gmail receipt');
    expect(
      sourceLabel({
        sourceType: 'gmail',
        viewerIsOwner: false,
        ownerFirstName: 'Jordan Lee',
        sharerFirstName: null,
        toldOn: null,
      }),
    ).toBe("Seen in Jordan's Gmail receipt");
    expect(
      sourceLabel({
        sourceType: 'group_share',
        viewerIsOwner: false,
        ownerFirstName: null,
        sharerFirstName: 'Priya',
        toldOn: null,
      }),
    ).toBe("Shared by Priya's family (opted in)");
    expect(
      sourceLabel({
        sourceType: 'parent',
        viewerIsOwner: true,
        ownerFirstName: null,
        sharerFirstName: null,
        toldOn: 'Sep 14',
      }),
    ).toBe('You told Hale · Sep\u00A014');
  });

  it('appends at most one line, and never onto an empty send', () => {
    expect(appendPassportLine('', 'Karate this fall?', false)).toMatchObject({
      skipped: 'no_outbound',
    });
    expect(appendPassportLine('Practice moved.', null, true)).toMatchObject({
      skipped: 'copy_unavailable',
    });
    expect(appendPassportLine('Practice moved.', 'Karate this fall?', true).body).toBe(
      'Practice moved.\n\nKarate this fall?',
    );
  });

  it('offers one next step per season and allows undo for 30 days', () => {
    expect(
      nextStepOffer({ alreadyOffered: true, sessionEnding: true, forbiddenActivityKeys: [] }),
    ).toBeNull();
    expect(
      nextStepOffer({
        alreadyOffered: false,
        sessionEnding: true,
        forbiddenActivityKeys: ['soccer'],
      })?.mode,
    ).toBe('next_season');
    const removed = new Date('2026-04-01T00:00:00Z');
    expect(canUndo(removed, NOW)).toBe(true);
    expect(canUndo(new Date('2026-02-01T00:00:00Z'), NOW)).toBe(false);
    expect(canUndo(null, NOW)).toBe(false);
  });
});

describe('assignChild', () => {
  it('matches one named child and does not guess between two', () => {
    expect(assignChild('Mia starts karate', null, [MIA, LEO])).toEqual({
      ok: true,
      childId: 'mia',
      ambiguous: false,
    });
    expect(assignChild('karate', null, [MIA, LEO])).toEqual({
      ok: true,
      childId: null,
      ambiguous: true,
    });
  });
});
