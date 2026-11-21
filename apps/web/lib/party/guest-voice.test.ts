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
    ['a lowercase instruction', `${GOOD_REMINDER} reply stop anytime`],
    ['the French line', `${GOOD_REMINDER} Répondez ARRÊT pour ne plus recevoir ces messages.`],
    ['a lowercase French instruction', `${GOOD_REMINDER} répondez arrêt`],
    ['a full-width keyword', `${GOOD_REMINDER} ＳＴＯＰ`],
    ['a keyword split by a zero-width space', `${GOOD_REMINDER} ST​OP`],
    ['a bare start keyword', `${GOOD_REMINDER} START`],
    ['a way out with no capitals', `${GOOD_REMINDER} Reply to stop getting these.`],
  ])('refuses %s', (_name, text) => {
    expect(acceptPartyGuestLine(text, REMINDER)).toBeNull();
  });

  it("does not read the facts' own words, or an ordinary verb, as a keyword", () => {
    const busStop: PartyGuestLine = { ...REMINDER, where: 'Bus STOP Cafe' };
    const onlyFact =
      "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at Bus STOP Cafe.";
    expect(acceptPartyGuestLine(onlyFact, busStop)).toBe(onlyFact);

    const shoutedTitle: PartyGuestLine = { ...REMINDER, title: 'STOP MOTION movie party' };
    const repeated = `It's Hale with the reminder you asked for: STOP MOTION movie party is tomorrow at 2:00 PM at 14 Elm St.`;
    expect(acceptPartyGuestLine(repeated, shoutedTitle)).toBe(repeated);

    const verb = `${GOOD_REMINDER} Stop by any time after 2.`;
    expect(acceptPartyGuestLine(verb, REMINDER)).toBe(verb);

    const infinitive =
      "It's Hale. You asked me to text you to help you remember: Nora's party is tomorrow at 14 Elm St.";
    expect(acceptPartyGuestLine(infinitive, REMINDER)).toBe(infinitive);

    const startTime =
      "It's Hale. You asked me to text you the start time: Nora's party is tomorrow at 2:00 PM at 14 Elm St.";
    expect(acceptPartyGuestLine(startTime, REMINDER)).toBe(startTime);
  });

  it('still refuses a fact that is itself a keyword instruction', () => {
    const hostile: PartyGuestLine = { ...REMINDER, where: 'Reply STOP to 12345' };
    const repeated =
      "It's Hale with the reminder you asked for: Nora's party is tomorrow at 2:00 PM at Reply STOP to 12345.";
    expect(acceptPartyGuestLine(repeated, hostile)).toBeNull();
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

    expect(text).toBe(GOOD_REMINDER);
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

    expect(text).toBe(GOOD_REMINDER);
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

    expect(text).toBe(GOOD_REMINDER);
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

    expect(text).toBeNull();
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

    expect(text).toBeNull();
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

    expect(text).toBeNull();
    expect(pages).toHaveLength(1);
  });
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
