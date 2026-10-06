import { describe, expect, it, vi } from 'vitest';
import {
  type PlacedEventRow,
  applyPlacedGoogleCalendar,
  selectGcalConnection,
} from './google-calendar-placement';
import { CALENDAR_EVENTS_SCOPE } from './google-write-flag';

const READONLY = 'https://www.googleapis.com/auth/calendar.readonly';

function event(overrides: Partial<PlacedEventRow> = {}): PlacedEventRow {
  return {
    id: 'fe-1',
    title: 'Swim',
    startsAt: new Date('2026-07-10T14:00:00.000Z'),
    endsAt: null,
    location: null,
    placedGoogleEventId: null,
    placedGoogleIntegrationId: null,
    ...overrides,
  };
}

describe('selectGcalConnection', () => {
  const parent = { id: 'int-a', userId: 'user-a', scopes: [READONLY, CALENDAR_EVENTS_SCOPE] };
  const readonly = { id: 'int-b', userId: 'user-b', scopes: [READONLY] };

  it('will not update or delete an event Hale did not create', () => {
    expect(
      selectGcalConnection({
        op: 'delete',
        actorUserId: 'user-a',
        placedGoogleEventId: null,
        placedGoogleIntegrationId: null,
        connections: [parent],
      }),
    ).toEqual({ ok: false, reason: 'not_ours' });
  });

  it('uses the connection that created the event, and skips when that grant lacks the write scope', () => {
    expect(
      selectGcalConnection({
        op: 'update',
        actorUserId: 'user-b',
        placedGoogleEventId: 'g-1',
        placedGoogleIntegrationId: 'int-a',
        connections: [parent, readonly],
      }),
    ).toEqual({ ok: true, integrationId: 'int-a' });
    expect(
      selectGcalConnection({
        op: 'delete',
        actorUserId: 'user-b',
        placedGoogleEventId: 'g-1',
        placedGoogleIntegrationId: 'int-b',
        connections: [readonly],
      }),
    ).toEqual({ ok: false, reason: 'scope_missing' });
  });

  it('does not guess between two scoped calendars when nobody approved the placement', () => {
    const other = { id: 'int-c', userId: 'user-c', scopes: [CALENDAR_EVENTS_SCOPE] };
    expect(
      selectGcalConnection({
        op: 'create',
        actorUserId: null,
        placedGoogleEventId: null,
        placedGoogleIntegrationId: null,
        connections: [parent, other],
      }),
    ).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('names a missing scope separately from a missing connection', () => {
    expect(
      selectGcalConnection({
        op: 'create',
        actorUserId: 'user-b',
        placedGoogleEventId: null,
        placedGoogleIntegrationId: null,
        connections: [readonly],
      }),
    ).toEqual({ ok: false, reason: 'scope_missing' });
    expect(
      selectGcalConnection({
        op: 'create',
        actorUserId: 'user-a',
        placedGoogleEventId: null,
        placedGoogleIntegrationId: null,
        connections: [],
      }),
    ).toEqual({ ok: false, reason: 'not_connected' });
  });
});

describe('applyPlacedGoogleCalendar', () => {
  it('does no work when the flag is off', async () => {
    const loadEvent = vi.fn();
    const report = await applyPlacedGoogleCalendar(
      { familyId: 'fam', familyEventId: 'fe-1', op: 'create', actorUserId: 'user-a' },
      {
        flagOn: false,
        loadEvent,
        listGcal: async () => [],
        accessToken: async () => 'tok',
        write: async () => ({ googleEventId: 'g' }),
        storePlaced: async () => {},
        audit: async () => {},
      },
    );
    expect(report).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(loadEvent).not.toHaveBeenCalled();
  });

  it('stores the id Hale created and does not call Google again when that id is already there', async () => {
    const write = vi.fn(async () => ({ googleEventId: 'g-new' }));
    const storePlaced = vi.fn(async () => {});
    const audits: string[] = [];
    const created = await applyPlacedGoogleCalendar(
      { familyId: 'fam', familyEventId: 'fe-1', op: 'create', actorUserId: 'user-a' },
      {
        flagOn: true,
        loadEvent: async () => event(),
        listGcal: async () => [{ id: 'int-a', userId: 'user-a', scopes: [CALENDAR_EVENTS_SCOPE] }],
        accessToken: async () => 'tok',
        write,
        storePlaced,
        audit: async (entry) => {
          audits.push(entry.actionTaken);
        },
      },
    );
    expect(created).toEqual({ status: 'written', googleEventId: 'g-new' });
    expect(storePlaced).toHaveBeenCalledWith('fe-1', 'g-new', 'int-a');
    expect(audits).toEqual(['integration.google_calendar_written']);

    write.mockClear();
    const again = await applyPlacedGoogleCalendar(
      { familyId: 'fam', familyEventId: 'fe-1', op: 'create', actorUserId: 'user-a' },
      {
        flagOn: true,
        loadEvent: async () =>
          event({ placedGoogleEventId: 'g-new', placedGoogleIntegrationId: 'int-a' }),
        listGcal: async () => [{ id: 'int-a', userId: 'user-a', scopes: [CALENDAR_EVENTS_SCOPE] }],
        accessToken: async () => 'tok',
        write,
        storePlaced,
        audit: async () => {},
      },
    );
    expect(again).toEqual({ status: 'skipped', reason: 'already_present' });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a failed Google write named, and does not store an id', async () => {
    const storePlaced = vi.fn();
    const report = await applyPlacedGoogleCalendar(
      { familyId: 'fam', familyEventId: 'fe-1', op: 'create', actorUserId: 'user-a' },
      {
        flagOn: true,
        loadEvent: async () => event(),
        listGcal: async () => [{ id: 'int-a', userId: 'user-a', scopes: [CALENDAR_EVENTS_SCOPE] }],
        accessToken: async () => 'tok',
        write: async () => {
          throw new Error('google calendar write failed: 500');
        },
        storePlaced,
        audit: async () => {},
      },
    );
    expect(report).toEqual({ status: 'failed', reason: 'google_error' });
    expect(storePlaced).not.toHaveBeenCalled();
  });

  it('does not call Google when the scope is missing', async () => {
    const write = vi.fn();
    const report = await applyPlacedGoogleCalendar(
      { familyId: 'fam', familyEventId: 'fe-1', op: 'delete', actorUserId: 'user-a' },
      {
        flagOn: true,
        loadEvent: async () =>
          event({ placedGoogleEventId: 'g-1', placedGoogleIntegrationId: 'int-a' }),
        listGcal: async () => [{ id: 'int-a', userId: 'user-a', scopes: [READONLY] }],
        accessToken: async () => 'tok',
        write,
        storePlaced: async () => {},
        audit: async () => {},
      },
    );
    expect(report).toEqual({ status: 'skipped', reason: 'scope_missing' });
    expect(write).not.toHaveBeenCalled();
  });
});
