import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { smsSegments } from '~/lib/channel/sms-segments';
import type { LoopMessage } from '~/lib/channel/types';
import { inviteLinkHash } from '~/lib/loop/calendar-invite-link-hash';
import {
  calendarInviteSmsRenderer,
  splitInviteSms,
} from '~/lib/loop/templates/calendar-invite/sms';
import {
  type CalendarInviteTimeJudge,
  type CalendarInviteVoiceRequest,
  INVITE_LINK_SLOT,
  MAX_INVITE_SEGMENTS,
  MAX_INVITE_SUMMARY_CHARS,
  calendarInviteRefusals,
  calendarInviteTimeInput,
  calendarInviteTimeUserMessage,
  calendarInviteUserMessage,
  createCalendarInviteVoice,
  fillCalendarInvite,
  prepareCalendarInvite,
  timeJsonSchema,
} from './calendar-invite-voice';

const LINK = `https://app.villagehale.com/api/ics/event/${'a'.repeat(36)}.${'b'.repeat(43)}`;

/** Thu, Jul 23 2026, 10:30 AM in New York. */
const STARTS = new Date('2026-07-23T14:30:00.000Z');

const REQUEST: CalendarInviteVoiceRequest = {
  summary: 'Swim class',
  when: 'Thu, Jul 23 at 10:30 AM',
  url: LINK,
  startsAt: STARTS,
  timeZone: 'America/New_York',
  language: 'en',
};

const PASSING = `Swim class on Thu, Jul 23 at 10:30 AM is on the week. Open this: ${INVITE_LINK_SLOT}`;

describe('calendarInviteRefusals', () => {
  it('passes a line that names the event, states its clock, and leaves the link as a slot', () => {
    expect(calendarInviteRefusals(PASSING, REQUEST)).toEqual([]);
    const filled = fillCalendarInvite(PASSING, LINK);
    expect(filled).toContain(LINK);
    expect(filled).not.toContain(INVITE_LINK_SLOT);
  });

  it('does not treat digits inside the url as numbers the model invented', () => {
    const numbered = `https://app.villagehale.com/api/ics/event/${'1'.repeat(36)}.${'2'.repeat(43)}`;
    expect(calendarInviteRefusals(PASSING, { ...REQUEST, url: numbered })).not.toContain(
      'invented_number',
    );
  });

  it('refuses a text that types a url or skips the slot', () => {
    expect(calendarInviteRefusals('Open this Thu, Jul 23 at 10:30 AM.', REQUEST)).toEqual([
      'link_missing',
    ]);
    expect(
      calendarInviteRefusals(`Swim class on Thu, Jul 23 at 10:30 AM: ${LINK}`, REQUEST),
    ).toEqual(expect.arrayContaining(['carries_destination', 'link_missing']));
  });

  it('refuses a repeated slot, a second placeholder, and an invented time', () => {
    expect(
      calendarInviteRefusals(
        `We put Swim class at 4:15 on Thu, Jul 23 ${INVITE_LINK_SLOT} and ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toEqual(expect.arrayContaining(['link_repeated', 'invented_number']));
    expect(
      calendarInviteRefusals(
        `Swim class on Thu, Jul 23 at 10:30 AM ${INVITE_LINK_SLOT} [[map]]`,
        REQUEST,
      ),
    ).toContain('stray_slot');
  });

  it('does not refuse a long line inside the bound, a lowercase start, or we', () => {
    const long = `${'Swim class '.repeat(40)}on Thu, Jul 23 at 10:30 AM. ${INVITE_LINK_SLOT}`;
    expect(smsSegments(fillCalendarInvite(long, LINK))).toBeLessThanOrEqual(MAX_INVITE_SEGMENTS);
    expect(calendarInviteRefusals(long, REQUEST)).toEqual([]);
    expect(
      calendarInviteRefusals(
        `we put Swim class on Thu, Jul 23 at 10:30 AM. ${INVITE_LINK_SLOT}`,
        REQUEST,
      ),
    ).toEqual([]);
  });

  it('does not force a HH:MM clock, in English or any other way of saying the hour', () => {
    for (const line of [
      `Swim class at 10am. ${INVITE_LINK_SLOT}`,
      `Swim class à 10 h. ${INVITE_LINK_SLOT}`,
      `Swim class 上午10点 ${INVITE_LINK_SLOT}`,
      `Swim class on Jul 10 at 23:30. ${INVITE_LINK_SLOT}`,
    ]) {
      expect(calendarInviteRefusals(line, REQUEST)).not.toContain('when_missing');
    }
  });

  it('keeps an em dash in the summary as the fact, and does not fold it away', () => {
    const named: CalendarInviteVoiceRequest = {
      ...REQUEST,
      summary: 'Maya \u2014 Swim class',
    };
    const raw = `Maya \u2014 Swim class on Thu, Jul 23 at 10:30 AM is on the week. Open this: ${INVITE_LINK_SLOT}`;
    expect(calendarInviteRefusals(raw, named)).toEqual([]);
  });

  it('does not refuse a text that names the event in translation: the time judge reads that', () => {
    expect(
      calendarInviteRefusals(`Cours de natation jeudi \u00e0 10 h 30. ${INVITE_LINK_SLOT}`, {
        ...REQUEST,
        language: 'fr',
      }),
    ).toEqual([]);
  });
});

describe('VIL-588 · the only destination in the text is the slot', () => {
  it('refuses a draft that echoes a summary carrying a bare domain call to action', () => {
    const hostile: CalendarInviteVoiceRequest = {
      ...REQUEST,
      summary: 'Swim class - sign up at kids-swim.example.org',
    };
    expect(
      calendarInviteRefusals(
        `Swim class - sign up at kids-swim.example.org on Thu, Jul 23 at 10:30 AM. ${INVITE_LINK_SLOT}`,
        hostile,
      ),
    ).toContain('carries_destination');
  });

  it('refuses a draft that adds a bare domain of its own', () => {
    for (const line of [
      `Swim class on Thu, Jul 23 at 10:30 AM, see swim.example.test/kids for more. ${INVITE_LINK_SLOT}`,
      `Swim class on Thu, Jul 23 at 10:30 AM. ${INVITE_LINK_SLOT} or Pool.Example.ORG`,
      `Swim class on Thu, Jul 23 at 10:30 AM, write to desk@example.test ${INVITE_LINK_SLOT}`,
    ]) {
      expect(calendarInviteRefusals(line, REQUEST)).toContain('carries_destination');
    }
  });

  it('positive control: dotted abbreviations and decimals are not a destination', () => {
    const dotted: CalendarInviteVoiceRequest = {
      ...REQUEST,
      summary: 'Jr. Lifeguards 2.5 km swim, e.g. U.S. rules',
    };
    expect(
      calendarInviteRefusals(
        `Jr. Lifeguards 2.5 km swim, e.g. U.S. rules on Thu, Jul 23 at 10:30 a.m. ${INVITE_LINK_SLOT}`,
        dotted,
      ),
    ).not.toContain('carries_destination');
    expect(calendarInviteRefusals(PASSING, REQUEST)).not.toContain('carries_destination');
  });

  it('reads the removed slot as a gap, so its neighbours never join into a domain', () => {
    expect(
      calendarInviteRefusals(
        `Swim class Thu, Jul 23 at 10:30 AM. Add it.${INVITE_LINK_SLOT}ca va`,
        REQUEST,
      ),
    ).not.toContain('carries_destination');
    expect(
      calendarInviteRefusals(
        `Swim class Thu, Jul 23 at 10:30 AM. Add it. ${INVITE_LINK_SLOT} kids.example.org`,
        REQUEST,
      ),
    ).toContain('carries_destination');
  });
});

describe('VIL-588 · an over-long text is refused, not sent', () => {
  it('refuses a filled text over the segment bound', () => {
    const tooLong = `${'Swim class on Thu, Jul 23 at 10:30 AM. '.repeat(30)}${INVITE_LINK_SLOT}`;
    expect(smsSegments(fillCalendarInvite(tooLong, LINK))).toBeGreaterThan(MAX_INVITE_SEGMENTS);
    expect(calendarInviteRefusals(tooLong, REQUEST)).toContain('too_long');
    expect(calendarInviteRefusals(PASSING, REQUEST)).not.toContain('too_long');
  });
});

describe('VIL-588 · the summary is checked before any model call', () => {
  function countingWriter(): { client: AgentClient; calls: () => number } {
    let calls = 0;
    const create = async (body: { messages: { content: string }[] }) => {
      calls += 1;
      const facts = JSON.parse(body.messages[0]?.content ?? '{}');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ text: `${facts.summary}, ${facts.when}. ${facts.linkSlot}` }),
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    return { client: { messages: { create } } as unknown as AgentClient, calls: () => calls };
  }
  const agrees: CalendarInviteTimeJudge = { matches: async () => true };

  it('defers summary_too_long over the bound and never calls the writer', async () => {
    const writer = countingWriter();
    const voice = createCalendarInviteVoice(() => writer.client, agrees);
    const outcome = await voice.compose({
      ...REQUEST,
      summary: 'S'.repeat(MAX_INVITE_SUMMARY_CHARS + 1),
    });
    expect(outcome).toEqual({ status: 'deferred', reason: 'summary_too_long' });
    expect(writer.calls()).toBe(0);
  });

  it('positive control: a summary at the bound reaches the writer and is sent', async () => {
    const writer = countingWriter();
    const voice = createCalendarInviteVoice(() => writer.client, agrees);
    const summary = 'S'.repeat(MAX_INVITE_SUMMARY_CHARS);
    const outcome = await voice.compose({ ...REQUEST, summary });
    expect(writer.calls()).toBe(1);
    expect(outcome).toEqual({
      status: 'composed',
      body: `${summary}, Thu, Jul 23 at 10:30 AM. ${LINK}`,
    });
  });

  it('defers summary_carries_destination for a summary carrying a domain and never calls the writer', async () => {
    const writer = countingWriter();
    const voice = createCalendarInviteVoice(() => writer.client, agrees);
    const outcome = await voice.compose({
      ...REQUEST,
      summary: 'Swim class - sign up at kids-swim.example.org',
    });
    expect(outcome).toEqual({ status: 'deferred', reason: 'summary_carries_destination' });
    expect(writer.calls()).toBe(0);
  });
});

describe('VIL-588 · the time judge gives its reason before its verdict', () => {
  it('requires reason and match, reason first', () => {
    expect(Object.keys(timeJsonSchema.properties)).toEqual(['reason', 'match']);
    expect(timeJsonSchema.required).toEqual(['reason', 'match']);
  });
});

describe('prepareCalendarInvite', () => {
  it('fills the slot and leaves accents, dashes, and other scripts as written', () => {
    const prepared = prepareCalendarInvite(
      `Swim class on Thu, Jul 23 at 10:30 AM \u2014 Chlo\u00e9 \u5468 ${INVITE_LINK_SLOT}`,
      REQUEST,
    );
    expect(prepared.status).toBe('accepted');
    if (prepared.status !== 'accepted') return;
    expect(prepared.body).toContain('\u2014');
    expect(prepared.body).toContain('Chlo\u00e9');
    expect(prepared.body).toContain('\u5468');
    expect(prepared.body.endsWith(LINK)).toBe(true);
    expect(prepared.body).not.toContain(INVITE_LINK_SLOT);
  });
});

describe('calendarInviteUserMessage', () => {
  it('hands the language and the slot, never the url or a segment budget', () => {
    const payload = JSON.parse(calendarInviteUserMessage(REQUEST)) as Record<string, unknown>;
    expect(payload).toEqual({
      summary: REQUEST.summary,
      when: REQUEST.when,
      language: 'en',
      linkSlot: INVITE_LINK_SLOT,
    });
    expect(calendarInviteUserMessage({ ...REQUEST, language: 'fr' })).toContain('"language":"fr"');
    expect(calendarInviteUserMessage(REQUEST)).not.toContain(LINK);
    expect(calendarInviteUserMessage(REQUEST)).not.toContain('maxSegments');
    expect(
      JSON.parse(calendarInviteUserMessage(REQUEST, [{ text: 'x', problems: ['empty'] }])).rejected,
    ).toEqual([{ text: 'x', problems: ['empty'] }]);
  });
});

describe('splitInviteSms', () => {
  it('sends a short line whole and splits a long one without cutting the link', () => {
    const short = `Swim class. ${LINK}`;
    expect(splitInviteSms(short)).toEqual([short]);
    const long = `${'Swim class on Thu, Jul 23 at 10:30 AM. '.repeat(8)}${LINK}`;
    const parts = splitInviteSms(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' ')).toBe(long);
    expect(parts.filter((part) => part.includes('https://'))).toEqual([
      parts.find((part) => part.includes(LINK)),
    ]);
    expect(parts.some((part) => part.includes(LINK))).toBe(true);
  });

  it('asks the dispatch to store the event-id hash on the part that carries the link', () => {
    const familyEventId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const url = `https://app.villagehale.com/api/ics/event/${familyEventId}.sig`;
    const line = `Swim class on Thu, Jul 23 at 10:30 AM. ${url}`;
    const rendered = calendarInviteSmsRenderer.render(
      {
        templateKey: 'calendar_invite_sms',
        familyId: 'fam',
        parentUserId: 'parent',
        category: 'approval',
        urgency: 'time_sensitive',
        channel: 'sms',
        payload: {
          familyEventId,
          summary: 'Swim class',
          when: 'Thu, Jul 23 at 10:30 AM',
          url,
          line,
        },
      } satisfies LoopMessage,
      'sms',
      'generic',
    );
    expect(rendered.recordBody).toBeFalsy();
    expect(rendered.linkHashFor).toBe(url);
    expect(rendered.linkHash).toBe(inviteLinkHash(familyEventId));
  });

  it('does not fold the model line on the way out', () => {
    const line = `Swim class on Thu, Jul 23 at 10:30 AM \u2014 Chlo\u00e9 \u5468 ${LINK}`;
    const rendered = calendarInviteSmsRenderer.render(
      {
        templateKey: 'calendar_invite_sms',
        familyId: 'fam',
        parentUserId: 'parent',
        category: 'approval',
        urgency: 'time_sensitive',
        channel: 'sms',
        payload: {
          familyEventId: 'a'.repeat(36),
          summary: 'Swim class',
          when: 'Thu, Jul 23 at 10:30 AM',
          url: LINK,
          line,
        },
      } satisfies LoopMessage,
      'sms',
      'generic',
    );
    const wire = rendered.texts?.join(' ') ?? rendered.text;
    expect(wire).toContain('\u2014');
    expect(wire).toContain('Chlo\u00e9');
    expect(wire).toContain('\u5468');
    expect(wire).toContain(LINK);
  });
});

describe('the time judge request', () => {
  it('shows the stated time and the real start, never the url', () => {
    const line = `Swim class at 10am. ${INVITE_LINK_SLOT}`;
    const message = calendarInviteTimeUserMessage(calendarInviteTimeInput(line, REQUEST));
    const payload = JSON.parse(message) as {
      text: string;
      starts: { hour: number; minute: number };
    };
    expect(payload.text).toContain('10am');
    expect(payload.starts).toEqual({
      year: 2026,
      month: 7,
      day: 23,
      hour: 10,
      minute: 30,
      weekday: 'Thursday',
    });
    expect(message).not.toContain(LINK);
  });
});

describe('VIL-515 · the invite template authors no fixed confirmation', () => {
  it('has no parent-facing Added line left in the sms module', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../templates/calendar-invite/sms.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('Added -');
    expect(source).not.toContain("Tap to put it on your phone's calendar");
    expect(source).not.toContain('gsmSafe');
  });

  it('does not tell the parent the event is already on their calendar', () => {
    const skill = readFileSync(
      fileURLToPath(
        new URL('../../../../../packages/agent/skills/calendar-invite-voice.md', import.meta.url),
      ),
      'utf8',
    );
    expect(skill).not.toContain('on the calendar now');
    expect(skill).toContain(
      "Hale has it in their plans, and opening the link adds it to their phone's calendar",
    );
    expect(skill).toContain('friend texting');
  });
});
