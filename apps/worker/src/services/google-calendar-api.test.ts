import { describe, expect, it, vi } from 'vitest';
import {
  type GoogleCalendarFetch,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from './google-calendar-api.js';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? '' : JSON.stringify(body)),
  };
}

describe('Google Calendar event writes', () => {
  const input = {
    summary: 'Swim',
    location: 'Pool',
    startsAt: new Date('2026-07-10T14:00:00.000Z'),
    endsAt: new Date('2026-07-10T14:45:00.000Z'),
  };

  it('creates on the primary calendar and does not ask Google to email guests', async () => {
    const fetchImpl = vi.fn<GoogleCalendarFetch>(async () => jsonResponse(200, { id: 'evt-1' }));
    const result = await createGoogleCalendarEvent('tok', input, fetchImpl);
    expect(result).toEqual({ googleEventId: 'evt-1' });
    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none',
    );
    expect(call?.[1].method).toBe('POST');
    expect(JSON.parse(String(call?.[1].body))).toMatchObject({
      summary: 'Swim',
      location: 'Pool',
      start: { dateTime: '2026-07-10T14:00:00.000Z' },
      end: { dateTime: '2026-07-10T14:45:00.000Z' },
    });
  });

  it('defaults a missing end to one hour and patches only the event Hale already stored', async () => {
    const fetchImpl = vi.fn<GoogleCalendarFetch>(async () => jsonResponse(200, { id: 'evt-9' }));
    await updateGoogleCalendarEvent(
      'tok',
      'evt-9',
      { ...input, endsAt: null, location: null },
      fetchImpl,
    );
    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-9?sendUpdates=none',
    );
    expect(call?.[1].method).toBe('PATCH');
    const body = JSON.parse(String(call?.[1].body)) as {
      end: { dateTime: string };
      location?: string;
    };
    expect(body.end.dateTime).toBe('2026-07-10T15:00:00.000Z');
    expect(body.location).toBeUndefined();
  });

  it('treats a missing event on delete as already gone', async () => {
    const fetchImpl = vi.fn<GoogleCalendarFetch>(async () =>
      jsonResponse(404, { error: { message: 'not found' } }),
    );
    const result = await deleteGoogleCalendarEvent('tok', 'evt-9', fetchImpl);
    expect(result).toEqual({ googleEventId: 'evt-9', alreadyGone: true });
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('names a non-success status and does not include the response body', async () => {
    const fetchImpl = vi.fn<GoogleCalendarFetch>(async () =>
      jsonResponse(403, { error: { message: 'Swim at the pool' } }),
    );
    await expect(createGoogleCalendarEvent('tok', input, fetchImpl)).rejects.toThrow(
      'google calendar write failed: 403',
    );
  });
});
