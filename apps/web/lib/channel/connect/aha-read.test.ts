import { describe, expect, it, vi } from 'vitest';
import {
  type AhaGoogleFetch,
  calendarFactsFromItems,
  calendarOverlaps,
  emailFactsFromMessages,
  readConnectedAha,
  withholdTeenMail,
} from './aha-read';

const NOW = new Date('2026-09-10T15:00:00.000Z');

describe('aha snapshot from fixture calendars and mail', () => {
  it('keeps upcoming events, a busy block, and a real overlap, and drops what is not upcoming', () => {
    const facts = calendarFactsFromItems(
      [
        {
          id: 'past',
          status: 'confirmed',
          summary: 'Yesterday swim',
          start: { dateTime: '2026-09-09T13:00:00.000Z' },
          end: { dateTime: '2026-09-09T14:00:00.000Z' },
        },
        {
          id: 'gone',
          status: 'cancelled',
          summary: 'Cancelled piano',
          start: { dateTime: '2026-09-12T13:00:00.000Z' },
          end: { dateTime: '2026-09-12T14:00:00.000Z' },
        },
        {
          id: 'swim',
          status: 'confirmed',
          summary: 'Swim at the rec centre',
          location: 'Rec centre',
          start: { dateTime: '2026-09-12T13:00:00.000Z' },
          end: { dateTime: '2026-09-12T14:00:00.000Z' },
        },
        {
          id: 'dentist',
          status: 'confirmed',
          summary: 'Dentist',
          start: { dateTime: '2026-09-12T13:30:00.000Z' },
          end: { dateTime: '2026-09-12T14:30:00.000Z' },
        },
        {
          id: 'busy',
          status: 'confirmed',
          summary: 'Busy',
          start: { dateTime: '2026-09-13T16:00:00.000Z' },
          end: { dateTime: '2026-09-13T17:00:00.000Z' },
        },
        {
          id: 'secret',
          status: 'confirmed',
          summary: 'notes@school.example',
          start: { dateTime: '2026-09-14T16:00:00.000Z' },
          end: { dateTime: '2026-09-14T17:00:00.000Z' },
        },
      ],
      NOW,
    );

    expect(facts.map((fact) => fact.title)).toEqual(['Swim at the rec centre', 'Dentist', 'Busy']);
    expect(facts[0]).toMatchObject({ location: 'Rec centre', declined: false, allDay: false });
    expect(calendarOverlaps(facts)).toEqual([
      { earlier: 'Swim at the rec centre', later: 'Dentist' },
    ]);
    expect(JSON.stringify(facts)).not.toMatch(/kind|deadline|intent|registration/i);
  });

  it('reads mail as subject, sender name, and snippet, without classifying it', () => {
    const facts = emailFactsFromMessages([
      {
        id: 'm1',
        internalDate: '1757606400000',
        snippet: 'Register by Friday. Reply to office@camp.example or call (416) 555-0199.',
        payload: {
          headers: [
            { name: 'Subject', value: 'Camp registration closes Friday' },
            { name: 'From', value: 'Camp Acorn <office@camp.example>' },
          ],
        },
      },
      {
        id: 'm2',
        internalDate: '1757692800000',
        snippet: 'See you there',
        payload: {
          headers: [
            { name: 'Subject', value: 'Picnic' },
            { name: 'From', value: 'office@camp.example' },
          ],
        },
      },
    ]);

    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      subject: 'Camp registration closes Friday',
      fromName: 'Camp Acorn',
    });
    expect(facts[0]?.snippet).toContain('Friday');
    expect(facts[0]?.snippet).not.toMatch(/@|416/);
    expect(facts[1]).toMatchObject({ subject: 'Picnic', fromName: null });
    expect(JSON.stringify(facts)).not.toMatch(/"deadline"|"kind"/);
  });

  it('withholds mailbox facts when a teenager is in the family, and keeps calendar facts', () => {
    const mail = withholdTeenMail({
      provider: 'gmail',
      read: 'ok',
      calendar: [],
      email: [
        {
          subject: 'Camp registration closes Friday',
          fromName: null,
          receivedAt: null,
          snippet: null,
        },
      ],
      overlaps: [],
    });
    expect(mail.read).toBe('withheld');
    expect(mail.email).toEqual([]);

    const calendar = withholdTeenMail({
      provider: 'gcal',
      read: 'ok',
      calendar: [
        {
          title: 'Swim at the rec centre',
          start: '2026-09-12T13:00:00.000Z',
          end: null,
          allDay: false,
          location: null,
          declined: false,
        },
      ],
      email: [],
      overlaps: [],
    });
    expect(calendar.read).toBe('ok');
    expect(calendar.calendar).toHaveLength(1);
  });

  it('reads the live window through the injected fetch and names a failed read', async () => {
    const googleFetch: AhaGoogleFetch = vi.fn(async (url: string) => {
      if (url.includes('/events')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                summary: 'Swim at the rec centre',
                start: { dateTime: '2026-09-12T13:00:00.000Z' },
                end: { dateTime: '2026-09-12T14:00:00.000Z' },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    });

    const calendar = await readConnectedAha({
      provider: 'gcal',
      accessToken: 'ya29.test',
      now: NOW,
      googleFetch,
    });
    expect(calendar.read).toBe('ok');
    expect(calendar.calendar[0]?.title).toBe('Swim at the rec centre');
    expect(calendar.email).toEqual([]);

    const mail = await readConnectedAha({
      provider: 'gmail',
      accessToken: 'ya29.test',
      now: NOW,
      googleFetch,
    });
    expect(mail).toMatchObject({ read: 'failed', email: [] });
  });

  it('does not query mail by keyword', async () => {
    const urls: string[] = [];
    const googleFetch: AhaGoogleFetch = async (url: string) => {
      urls.push(url);
      if (url.includes('/messages?')) {
        return { ok: true, status: 200, json: async () => ({ messages: [] }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const mail = await readConnectedAha({
      provider: 'gmail',
      accessToken: 'ya29.test',
      now: NOW,
      googleFetch,
    });
    expect(mail.read).toBe('empty');
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toMatch(/[?&]q=/);
  });
});
