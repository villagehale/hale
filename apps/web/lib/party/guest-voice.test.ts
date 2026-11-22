import type { PostHog } from 'posthog-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceAnthropic } from '~/lib/analytics/llm-trace';
import type { OpsPage, OpsPager } from '~/lib/monitoring/failure-page';
import { scriptedGuestLineClient } from '~/lib/testing/party-guest-client';
import {
  type PartyGuestLine,
  acceptPartyGuestLine,
  createPartyGuestLineWriter,
  partyGuestLineUserMessage,
  placeWithoutTextBackNumbers,
  withoutTextBackNumbers,
} from './guest-voice';

const REMINDER: PartyGuestLine = {
  why: 'asked_for_reminder',
  title: 'Birthday party for Nora',
  when: 'Saturday, December 12 at 2:00 PM',
  where: '14 Elm St',
};
const CANCELLED: PartyGuestLine = { ...REMINDER, why: 'host_cancelled' };

const GOOD_REMINDER =
  "It's Hale with the reminder you asked for: Nora's birthday party is tomorrow, Saturday, December 12 at 2:00 PM at 14 Elm St.";
const GOOD_CANCELLED =
  "It's Hale: the host has cancelled Nora's birthday party on Saturday, December 12. Sorry for the change.";

function recordingPager() {
  const pages: OpsPage[] = [];
  const pager: OpsPager = {
    async page(page) {
      pages.push(page);
      return 'paged';
    },
  };
  return { pager, pages };
}

describe('acceptPartyGuestLine', () => {
  it('passes a line that says who, what and why (positive control)', () => {
    expect(acceptPartyGuestLine(`  ${GOOD_REMINDER}\n`, REMINDER)).toBe(GOOD_REMINDER);
    expect(acceptPartyGuestLine(GOOD_CANCELLED, CANCELLED)).toBe(GOOD_CANCELLED);
  });

  it('refuses an empty line', () => {
    expect(acceptPartyGuestLine('   ', REMINDER)).toBeNull();
  });

  it('refuses a line that does not say it is from Hale: the guest has no idea who this is', () => {
    expect(
      acceptPartyGuestLine(GOOD_REMINDER.replace("It's Hale with", 'Here is'), REMINDER),
    ).toBeNull();
  });

  it('refuses a garbled line before the send seam would', () => {
    expect(acceptPartyGuestLine(`${GOOD_REMINDER} �`, REMINDER)).toBeNull();
  });

  it('refuses a reminder that dropped or changed the place', () => {
    expect(acceptPartyGuestLine(GOOD_REMINDER.replace(' at 14 Elm St', ''), REMINDER)).toBeNull();
    expect(
      acceptPartyGuestLine(GOOD_REMINDER.replace('14 Elm St', '41 Elm St'), REMINDER),
    ).toBeNull();
  });

  it('refuses a house number that only contains the right one', () => {
    expect(
      acceptPartyGuestLine(GOOD_REMINDER.replace('14 Elm St', '114 Elm St'), REMINDER),
    ).toBeNull();
    expect(
      acceptPartyGuestLine(GOOD_REMINDER.replace('14 Elm St', '14 Elm Street'), REMINDER),
    ).toBeNull();
  });

  it.each([
    ['no time at all', GOOD_REMINDER.replace(', Saturday, December 12 at 2:00 PM', '')],
    ['the wrong hour', GOOD_REMINDER.replace('2:00 PM', '3:00 PM')],
    ['the wrong minutes', GOOD_REMINDER.replace('2:00 PM', '2:30 PM')],
    ['only the day of the month', GOOD_REMINDER.replace(' at 2:00 PM', '')],
    ['the wrong half of the day', GOOD_REMINDER.replace('2:00 PM', '2:00 am')],
    ['the wrong half, dotted', GOOD_REMINDER.replace('2:00 PM', '2 a.m.')],
  ])('refuses a reminder with %s', (_name, text) => {
    expect(acceptPartyGuestLine(text, REMINDER)).toBeNull();
  });

  it.each(['2:00 PM', '2 PM', '2pm', '2 p.m.', '14 h', '14h', '14h00', '14:00'])(
    'accepts the time written as %s',
    (clock) => {
      const text = GOOD_REMINDER.replace('2:00 PM', clock);
      expect(acceptPartyGuestLine(text, REMINDER)).toBe(text);
    },
  );

  it('reads minutes when the party is not on the hour', () => {
    const halfPast: PartyGuestLine = { ...REMINDER, when: 'Saturday, December 12 at 2:30 PM' };
    const ok = GOOD_REMINDER.replace('2:00 PM', '14 h 30');
    expect(acceptPartyGuestLine(ok, halfPast)).toBe(ok);
    expect(acceptPartyGuestLine(GOOD_REMINDER.replace('2:00 PM', '2 PM'), halfPast)).toBeNull();
  });

  it('reads a morning party and the narrow space ICU can put before the half', () => {
    const morning: PartyGuestLine = { ...REMINDER, when: 'Saturday, December 12 at 10:00\u202fAM' };
    const ok = GOOD_REMINDER.replace('2:00 PM', '10 a.m.');
    expect(acceptPartyGuestLine(ok, morning)).toBe(ok);
    expect(acceptPartyGuestLine(GOOD_REMINDER.replace('2:00 PM', '10 p.m.'), morning)).toBeNull();
  });

  it('does not take a number in the title or place for the time', () => {
    const titled: PartyGuestLine = { ...REMINDER, title: "Nora's 2nd birthday" };
    const noClock =
      "It's Hale with the reminder you asked for: Nora's 2nd birthday is tomorrow at 14 Elm St.";
    expect(acceptPartyGuestLine(noClock, titled)).toBeNull();

    const roomNamedLikeATime: PartyGuestLine = { ...REMINDER, where: 'Salle 14h' };
    const onlyTheRoom =
      "It's Hale with the reminder you asked for: Nora's party is tomorrow at Salle 14h.";
    expect(acceptPartyGuestLine(onlyTheRoom, roomNamedLikeATime)).toBeNull();
  });

  it('reads the place past a trailing stop and accents, and needs none on a cancellation', () => {
    const fr: PartyGuestLine = {
      why: 'asked_for_reminder',
      title: 'Anniversaire de Léa',
      when: 'Saturday, December 12 at 2:00 PM',
      where: 'Parc Laurier, Montréal.',
    };
    const line =
      "C'est Hale, avec le rappel demandé : l'anniversaire de Léa est demain, samedi 12 décembre à 14 h, au Parc Laurier, Montréal.";
    expect(acceptPartyGuestLine(line, fr)).toBe(line);
    expect(acceptPartyGuestLine(GOOD_CANCELLED, CANCELLED)).toBe(GOOD_CANCELLED);
  });

  it.each([
    ['the opt-out line', `${GOOD_REMINDER} Reply STOP to opt out.`],
    ['help in capitals', `${GOOD_REMINDER} Text HELP for help.`],
    ['the French line', `${GOOD_REMINDER} Répondez ARRÊT pour ne plus recevoir ces messages.`],
    ['a full-width keyword', `${GOOD_REMINDER} ＳＴＯＰ`],
    ['a keyword split by a zero-width space', `${GOOD_REMINDER} ST\u200bOP`],
    ['a bare start keyword', `${GOOD_REMINDER} START`],
    ['a keyword nobody listed', `${GOOD_REMINDER} Text QUIT to end these.`],
    ['a time marker the facts do not hold', GOOD_REMINDER.replace('2:00 PM', '2:00 AM')],
  ])('refuses %s', (_name, text) => {
    expect(acceptPartyGuestLine(text, REMINDER)).toBeNull();
  });

  it("reads a fact's own capitals as the fact, and nothing the draft adds around them", () => {
    const busStop: PartyGuestLine = { ...REMINDER, where: 'Bus STOP Cafe' };
    const onlyFact =
      "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at Bus STOP Cafe.";
    expect(acceptPartyGuestLine(onlyFact, busStop)).toBe(onlyFact);
    expect(acceptPartyGuestLine(`${onlyFact} Reply STOP to opt out.`, busStop)).toBeNull();

    const shoutedTitle: PartyGuestLine = { ...REMINDER, title: 'STOP MOTION movie party' };
    const repeated = `It's Hale with the reminder you asked for: STOP MOTION movie party is tomorrow at 2:00 PM at 14 Elm St.`;
    expect(acceptPartyGuestLine(repeated, shoutedTitle)).toBe(repeated);

    const acronym: PartyGuestLine = { ...REMINDER, where: 'YMCA pool' };
    const atThePool =
      "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at YMCA pool.";
    expect(acceptPartyGuestLine(atThePool, acronym)).toBe(atThePool);
  });

  describe('a place literally called STOP', () => {
    const place: PartyGuestLine = { ...REMINDER, where: 'STOP' };
    const saysWhere =
      "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at STOP.";

    it('passes a draft that only says where it is (positive control)', () => {
      expect(acceptPartyGuestLine(saysWhere, place)).toBe(saysWhere);
    });

    it.each([
      ['beside the place', `${saysWhere} STOP to 12345.`],
      ['before the place', `STOP to 12345. ${saysWhere}`],
      ['with no number', `${saysWhere} Reply STOP.`],
      [
        'as the only mention, with a number to text',
        "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM. STOP to 12345.",
      ],
    ])('refuses the keyword %s', (_name, text) => {
      expect(acceptPartyGuestLine(text, place)).toBeNull();
    });

    it('refuses it on a cancellation, which needs no place', () => {
      const note = "It's Hale: the host has cancelled Nora's party. STOP to 12345.";
      expect(acceptPartyGuestLine(note, { ...place, why: 'host_cancelled' })).toBeNull();
    });
  });

  it('does not let a fact exempt a longer shouted word it is only part of', () => {
    const place: PartyGuestLine = { ...CANCELLED, where: 'STO' };
    const draft = "It's Hale: the host has cancelled Nora's party. Reply STOP.";
    expect(acceptPartyGuestLine(draft, place)).toBeNull();
  });

  it('refuses a short code it was not handed', () => {
    expect(acceptPartyGuestLine(`${GOOD_REMINDER} Text 12345.`, REMINDER)).toBeNull();
  });

  describe('a title or place written to carry a number to text back', () => {
    const say = (rest: string) =>
      `It's Hale with the reminder you asked for: ${rest} is tomorrow at 2:00 PM at 14 Elm St.`;

    it.each<[string, PartyGuestLine, string]>([
      [
        'a title with a keyword and code',
        { ...REMINDER, title: 'Text WIN to 55555' },
        say('Text WIN to 55555'),
      ],
      [
        'a title teaching STOP',
        { ...REMINDER, title: 'Reply STOP to 12345' },
        say('Reply STOP to 12345'),
      ],
      [
        'a cancellation whose title carries one',
        { ...CANCELLED, title: 'Text WIN to 55512', where: null },
        "It's Hale: the host has cancelled Text WIN to 55512.",
      ],
      [
        'a place that carries one',
        { ...REMINDER, where: 'Text WIN to 55512' },
        "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at Text WIN to 55512.",
      ],
    ])('refuses %s', (_name, line, draft) => {
      expect(acceptPartyGuestLine(draft, line)).toBeNull();
    });

    it('refuses a title that still teaches a keyword once its number is gone', () => {
      const title = withoutTextBackNumbers('Reply STOP to 12345');
      expect(title).toBe('Reply STOP to');
      expect(acceptPartyGuestLine(say(title), { ...REMINDER, title })).toBeNull();
    });

    it.each([
      '55-555',
      '5 5 5 5 5',
      '555.555',
      '(555) 55',
      '123456',
      '5 55555',
      '55,555',
      '55/555',
      '55_555',
      '5   5   5   5   5',
      '55:555',
      '12:345',
      '12 3456',
      '1234 5',
      '1 2345',
    ])('refuses a code written as %s', (code) => {
      expect(acceptPartyGuestLine(`${GOOD_REMINDER} Text win to ${code}.`, REMINDER)).toBeNull();
    });

    it('passes an ordinary time, date and street number (positive control)', () => {
      const line: PartyGuestLine = { ...REMINDER, where: 'Suite 12, 1420 Elm St' };
      const draft =
        "It's Hale with the reminder you asked for: Nora's party is tomorrow, Saturday, December 12 at 2:00 PM at Suite 12, 1420 Elm St.";
      expect(acceptPartyGuestLine(draft, line)).toBe(draft);
    });
  });

  describe('a street address whose number could be a short code', () => {
    const at = (place: string) =>
      `It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at ${place}.`;

    it.each([
      '3-1420 Elm St',
      '12-345 Main St',
      '12345 Elm St',
      'Unit 3, 12-345 Main St',
      'Suite 12, 1420 Elm St',
      '10265, rue Sainte-Catherine',
    ])('keeps %s and passes a draft that names it once', (place) => {
      expect(placeWithoutTextBackNumbers(place)).toBe(place);
      expect(acceptPartyGuestLine(at(place), { ...REMINDER, where: place })).toBe(at(place));
    });

    it('refuses the same number named a second time', () => {
      const line: PartyGuestLine = { ...REMINDER, where: '12-345 Main St' };
      const draft = `${at('12-345 Main St')} Text win to 12-345.`;
      expect(acceptPartyGuestLine(draft, line)).toBeNull();
    });
  });

  it.each([
    "It's Hale with the reminder you asked for: Nora's party is tomorrow, December 12 2026 at 2:00 PM at 14 Elm St.",
    "It's Hale with the reminder you asked for: Nora's party is tomorrow, 12/12/2026 14:00 at 14 Elm St.",
    "It's Hale with the reminder you asked for: Nora's party is tomorrow, December 12, 2026 at 2:00 PM at 14 Elm St.",
    "It's Hale with the reminder you asked for: Nora's party is tomorrow, December 12, 2:00 PM at 14 Elm St.",
  ])('passes an ordinary date and time: %s', (draft) => {
    expect(acceptPartyGuestLine(draft, REMINDER)).toBe(draft);
  });

  it('refuses a code written right after the clock', () => {
    expect(acceptPartyGuestLine(`${GOOD_REMINDER} Text win at 14:00 12345.`, REMINDER)).toBeNull();
  });

  describe('withoutTextBackNumbers', () => {
    it('keeps no street number in a title', () => {
      expect(withoutTextBackNumbers('12345 Elm St party')).toBe('Elm St party');
    });

    it('cuts a code split around four digits', () => {
      expect(withoutTextBackNumbers('Text win to 12 3456')).toBe('Text win to');
    });

    it.each(['Party Dec 12 2026', 'Party Dec 12 2:30'])('leaves the date in %s', (title) => {
      expect(withoutTextBackNumbers(title)).toBe(title);
    });

    it.each([
      ['Text WIN to 55512', 'Text WIN to'],
      ['Hall 55-555', 'Hall'],
      ['123 Main St, Austin, TX 78701', '123 Main St, Austin, TX'],
      ['12345', ''],
    ])('takes the number out of the place %s', (place, expected) => {
      expect(placeWithoutTextBackNumbers(place)).toBe(expected);
    });

    it.each([
      ['Text WIN to 55555', 'Text WIN to'],
      ['123 Main St, Austin, TX 78701', '123 Main St, Austin, TX'],
      ['Unit 12345, 14 Elm St', 'Unit, 14 Elm St'],
      ['Hall 55-555', 'Hall'],
      ['Hall 5 5 5 5 5', 'Hall'],
      ['Hall 555.555', 'Hall'],
      ['12345', ''],
    ])('takes the number out of %s', (fact, expected) => {
      expect(withoutTextBackNumbers(fact)).toBe(expected);
    });

    it.each([
      '14 Elm St',
      'Suite 12',
      'Room 1234',
      'Party Palace, 416-555-0100',
      "Nora's party 12-12-2026",
      'Birthday party for Nora',
    ])('leaves %s alone', (fact) => {
      expect(withoutTextBackNumbers(fact)).toBe(fact);
    });
  });

  describe('a number to text back when a fact holds digits', () => {
    const remind = (rest: string) =>
      `It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM${rest}`;
    const cancelled = (title: string): PartyGuestLine => ({ ...CANCELLED, title, where: null });

    it.each<[string, PartyGuestLine, string]>([
      [
        'a place that is only that number, named first',
        { ...REMINDER, where: '12345' },
        remind(' at 12345. To opt out text stop to 12345.'),
      ],
      [
        'a place that is only that number, as the only mention',
        { ...REMINDER, where: '12345' },
        remind('. To opt out text stop to 12345.'),
      ],
      [
        'a place whose digits sit inside a longer number',
        { ...REMINDER, where: '555' },
        remind(' at 555. To opt out text stop to 55512.'),
      ],
      [
        'a one-digit title inside a longer number',
        cancelled('5'),
        "It's Hale: the host has cancelled the party. Text stop to 55555.",
      ],
      [
        'a title that is only that number',
        cancelled('12345'),
        "It's Hale: the host has cancelled the party. Text stop to 12345.",
      ],
      [
        'a second mention of a place that holds the number',
        { ...REMINDER, where: 'Suite 12345' },
        remind(' at Suite 12345. Text stop to Suite 12345.'),
      ],
      [
        'a different number than the place holds',
        { ...REMINDER, where: '556' },
        remind(' at 556. To opt out text stop to 55512.'),
      ],
    ])('refuses %s', (_name, line, draft) => {
      expect(acceptPartyGuestLine(draft, line)).toBeNull();
    });

    it('refuses a title left empty once its number is gone', () => {
      const line = cancelled(withoutTextBackNumbers('12345'));
      expect(acceptPartyGuestLine("It's Hale: the host has cancelled the party.", line)).toBeNull();
    });
  });

  it('does not read a wrong hour as right by lifting a digit-only title out of it', () => {
    const line: PartyGuestLine = { ...REMINDER, title: '1' };
    const wrongHour =
      "It's Hale with the reminder you asked for: the party is tomorrow at 12:00 PM at 14 Elm St.";
    const rightHour =
      "It's Hale with the reminder you asked for: the party is tomorrow at 2:00 PM at 14 Elm St.";
    expect(acceptPartyGuestLine(wrongHour, line)).toBeNull();
    expect(acceptPartyGuestLine(rightHour, line)).toBe(rightHour);
  });

  it('does not read an ordinary lowercase word as a keyword', () => {
    const verb = `${GOOD_REMINDER} Stop by any time after 2.`;
    expect(acceptPartyGuestLine(verb, REMINDER)).toBe(verb);
  });

  it.each([
    ['a link', `${GOOD_REMINDER} Details at evil.app/x`],
    ['a phone number', `${GOOD_REMINDER} Call 416-555-0199.`],
    ['an email address', `${GOOD_REMINDER} Write to host@example.test.`],
  ])('refuses %s it was not handed', (_name, text) => {
    expect(acceptPartyGuestLine(text, REMINDER)).toBeNull();
  });

  it("refuses a contact that is only in the party's title", () => {
    const titled: PartyGuestLine = { ...REMINDER, title: 'Nora party, call 416-555-0199' };
    const line =
      "It's Hale with the reminder you asked for: Nora party, call 416-555-0199 is tomorrow at 2:00 PM at 14 Elm St.";
    expect(acceptPartyGuestLine(line, titled)).toBeNull();
  });

  it('lets the place carry a number the host typed into it (positive control)', () => {
    const place: PartyGuestLine = { ...REMINDER, where: 'Party Palace, 416-555-0100' };
    const line =
      "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at Party Palace, 416-555-0100.";
    expect(acceptPartyGuestLine(line, place)).toBe(line);
  });
});

describe('createPartyGuestLineWriter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps the party out of the analytics trace even with content capture on', async () => {
    vi.stubEnv('POSTHOG_LLM_CONTENT_ENABLED', 'true');
    const { client } = scriptedGuestLineClient([GOOD_REMINDER]);
    const capture = vi.fn();
    const posthog = { capture, flush: vi.fn(async () => {}) } as unknown as PostHog;
    const traced = traceAnthropic(client as never, { stage: 'reminder' }, posthog);
    const { pager } = recordingPager();

    const text = await createPartyGuestLineWriter(() => traced as never, pager).write(REMINDER);

    expect(text).toEqual({ status: 'written', text: GOOD_REMINDER });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    const sent = capture.mock.calls[0]?.[0] as { properties: Record<string, unknown> };
    expect(sent.properties).toMatchObject({ hale_stage: 'reminder' });
    expect(sent.properties).not.toHaveProperty('$ai_input');
    expect(sent.properties).not.toHaveProperty('$ai_output_choices');
    expect(JSON.stringify(sent)).not.toContain('Nora');
  });

  it('returns the first usable text, and the prompt holds exactly the four facts', async () => {
    const { client, requests } = scriptedGuestLineClient([GOOD_REMINDER]);
    const { pager, pages } = recordingPager();

    const text = await createPartyGuestLineWriter(() => client, pager).write(REMINDER);

    expect(text).toEqual({ status: 'written', text: GOOD_REMINDER });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]?.messages[0]?.content as string)).toEqual({
      why: 'asked_for_reminder',
      title: 'Birthday party for Nora',
      when: 'Saturday, December 12 at 2:00 PM',
      where: '14 Elm St',
    });
    expect(pages).toEqual([]);
  });

  it('asks a smaller model once after an unusable draft', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, requests } = scriptedGuestLineClient([
      `${GOOD_REMINDER} Reply STOP to opt out.`,
      GOOD_REMINDER,
    ]);
    const { pager, pages } = recordingPager();

    const text = await createPartyGuestLineWriter(() => client, pager).write(REMINDER);

    expect(text).toEqual({ status: 'written', text: GOOD_REMINDER });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.model).not.toBe(requests[0]?.model);
    expect(pages).toEqual([]);
  });

  it('writes nothing and pages once when both drafts are unusable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, requests } = scriptedGuestLineClient([
      'Nora has a party.',
      'Nora has a party.',
    ]);
    const { pager, pages } = recordingPager();

    const text = await createPartyGuestLineWriter(() => client, pager).write(CANCELLED);

    expect(text).toEqual({ status: 'unwritten', page: 'paged' });
    expect(requests).toHaveLength(2);
    expect(pages).toEqual([
      { site: 'party_guest_unwritten', facts: { why: 'host_cancelled', stage: 'after_retry' } },
    ]);
  });

  it('writes nothing, pages once, and logs no words when the model call fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = scriptedGuestLineClient([
      new Error('upstream echoed Nora at 416-555-0142'),
      new Error('upstream echoed Nora at 416-555-0142'),
    ]);
    const { pager, pages } = recordingPager();

    const text = await createPartyGuestLineWriter(() => client, pager).write(REMINDER);

    expect(text).toEqual({ status: 'unwritten', page: 'paged' });
    expect(pages).toEqual([
      {
        site: 'party_guest_unwritten',
        facts: { why: 'asked_for_reminder', stage: 'after_retry' },
      },
    ]);
    expect(error).toHaveBeenCalled();
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('Error');
    expect(logged).not.toContain('Nora');
    expect(logged).not.toContain('416-555-0142');
  });

  it('pages once when no client can be built (a missing key is a failed write)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pager, pages } = recordingPager();

    const text = await createPartyGuestLineWriter(() => {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }, pager).write(REMINDER);

    expect(text).toEqual({ status: 'unwritten', page: 'paged' });
    expect(pages).toHaveLength(1);
  });

  it.each(['page_not_configured', 'page_failed', 'already_paged'] as const)(
    'names a page that came back %s',
    async (outcome) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const pager: OpsPager = { page: async () => outcome };

      const result = await createPartyGuestLineWriter(() => {
        throw new Error('model outage');
      }, pager).write(REMINDER);

      expect(result).toEqual({ status: 'unwritten', page: outcome });
    },
  );
});

describe('partyGuestLineUserMessage', () => {
  it('carries a null place as null, so the model cannot be handed an empty string', () => {
    expect(JSON.parse(partyGuestLineUserMessage({ ...REMINDER, where: null }))).toEqual({
      why: 'asked_for_reminder',
      title: 'Birthday party for Nora',
      when: 'Saturday, December 12 at 2:00 PM',
      where: null,
    });
  });
});
