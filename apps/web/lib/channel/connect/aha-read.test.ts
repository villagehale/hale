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
const EASTERN = 'America/Toronto';

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
      EASTERN,
    );

    expect(facts.map((fact) => fact.title)).toEqual(['Swim at the rec centre', 'Dentist', 'Busy']);
    expect(facts[0]).toMatchObject({ location: 'Rec centre', declined: false, allDay: false });
    expect(calendarOverlaps(facts, EASTERN)).toEqual([
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

  it('drops a link from a title, a subject and a snippet however it is written (VIL-632)', () => {
    const at = (id: string, summary: string) => ({
      id,
      status: 'confirmed',
      summary,
      start: { dateTime: '2026-09-12T13:00:00.000Z' },
      end: { dateTime: '2026-09-12T14:00:00.000Z' },
    });
    const titles = calendarFactsFromItems(
      [
        at('scheme', 'Verify at https://evil.app/login'),
        at('wide', 'Verify at https：//evil.app/login'),
        at('bare', 'Verify at evil.app/login'),
        at('only', 'evil.app/login'),
      ],
      NOW,
      EASTERN,
    ).map((fact) => fact.title);
    expect(titles).toEqual(['Verify at', 'Verify at', 'Verify at']);

    const mail = emailFactsFromMessages(
      [
        ['Order at https：//evil.app/pay today', 'Picture day https://evil.app/pay'],
        ['Order at evil.app/pay today', 'Picture day evil.app/pay'],
      ].map(([snippet, subject], index) => ({
        id: `m${index}`,
        internalDate: '1757606400000',
        snippet,
        payload: { headers: [{ name: 'Subject', value: subject }] },
      })),
    );
    expect(mail.map((fact) => [fact.subject, fact.snippet])).toEqual([
      ['Picture day', 'Order at today'],
      ['Picture day', 'Order at today'],
    ]);
  });

  it('a length cut never leaves a link behind (VIL-632)', () => {
    // 'evil.co9xyz' is not link-shaped; cut right after 'evil.co' it would be.
    const titleWords = 'Swim '.repeat(22).concat('ab');
    const snippetWords = 'Swim '.repeat(30).concat('ab');
    const event = (id: string, summary: string) => ({
      id,
      status: 'confirmed',
      summary,
      start: { dateTime: '2026-09-12T13:00:00.000Z' },
      end: { dateTime: '2026-09-12T14:00:00.000Z' },
    });
    const message = (id: string, subject: string, snippet: string) => ({
      id,
      internalDate: '1757606400000',
      snippet,
      payload: { headers: [{ name: 'Subject', value: subject }] },
    });
    const longPlain = 'Swim lesson at the pool '.repeat(10);

    const placeWords = 'Rec '.repeat(17).concat('abcd');
    const calendar = calendarFactsFromItems(
      [
        { ...event('cut', `${titleWords} evil.co9xyz`), location: `${placeWords} evil.co9xyz` },
        { ...event('plain', longPlain), location: longPlain },
      ],
      NOW,
      EASTERN,
    );
    expect(calendar.map((fact) => [fact.title, fact.location])).toEqual([
      [titleWords, placeWords],
      [longPlain.slice(0, 120).trimEnd(), longPlain.slice(0, 80).trimEnd()],
    ]);

    const mail = emailFactsFromMessages([
      message('cut', `${titleWords} evil.co9xyz`, `${snippetWords} evil.co9xyz`),
      message('plain', longPlain, longPlain),
    ]);
    expect(mail.map((fact) => [fact.subject, fact.snippet])).toEqual([
      [titleWords, snippetWords],
      [longPlain.slice(0, 120).trimEnd(), longPlain.slice(0, 160).trimEnd()],
    ]);
  });

  it("reads today on the family's own clock, so an all-day event today is still upcoming", () => {
    // 05:30Z on Nov 10: still Nov 9 in Chicago, already Nov 10 in Toronto.
    const lateEvening = new Date('2026-11-10T05:30:00.000Z');
    const items = [
      {
        id: 'fair',
        status: 'confirmed',
        summary: 'Fall fair',
        start: { date: '2026-11-09' },
        end: { date: '2026-11-10' },
      },
    ];
    expect(
      calendarFactsFromItems(items, lateEvening, 'America/Chicago').map((fact) => fact.title),
    ).toEqual(['Fall fair']);
    expect(calendarFactsFromItems(items, lateEvening, 'America/Toronto')).toEqual([]);
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
      timeZone: EASTERN,
      googleFetch,
    });
    expect(calendar.read).toBe('ok');
    expect(calendar.calendar[0]?.title).toBe('Swim at the rec centre');
    expect(calendar.email).toEqual([]);

    const mail = await readConnectedAha({
      provider: 'gmail',
      accessToken: 'ya29.test',
      now: NOW,
      timeZone: EASTERN,
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
      timeZone: EASTERN,
      googleFetch,
    });
    expect(mail.read).toBe('empty');
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toMatch(/[?&]q=/);
  });
});
