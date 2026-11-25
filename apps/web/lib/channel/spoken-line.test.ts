import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import { acceptSpokenLine, acceptSpokenRequest, createSpokenLineWriter } from './spoken-line';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('acceptSpokenLine: no link, phone or email it was not handed', () => {
  it.each([
    ['a link in the event name', "Leo's soccer pickup moved, see evil.app/x"],
    ['a bracketed link', "Leo's soccer moved, details at evil[.]app"],
    ['a phone', "Leo's soccer pickup moved, call 555-0199"],
    ['a spaced phone', "Leo's soccer pickup moved, call 5 5 5 0 1 9 9"],
    ['full-width digits', "Leo's soccer pickup moved, call ５５５－０１９９"],
    ['an email', "Leo's soccer moved, reply to coach@example"],
  ])('refuses %s', (_name, text) => {
    expect(acceptSpokenLine(text, [])).toBeNull();
    expect(acceptSpokenLine(text, undefined)).toBeNull();
  });

  it('passes a handed verbatim link and phone (positive control)', () => {
    const text = 'Connect it here: https://example.test/c - or call 1-800-555-0100.';
    expect(acceptSpokenLine(text, ['https://example.test/c', '1-800-555-0100'])).toBe(text);
  });

  it('passes short service numbers, which are not phones (positive control)', () => {
    expect(acceptSpokenLine('Text 988 any time, or call 811.', ['988'])).toBe(
      'Text 988 any time, or call 811.',
    );
  });

  it('still refuses a line missing a verbatim piece', () => {
    expect(acceptSpokenLine('Swim is cancelled.', ['https://example.test/c'])).toBeNull();
  });
});

describe('acceptSpokenLine: an addendum line names no opt-out keyword (VIL-706)', () => {
  const strict = { refuseOptOutKeyword: true };

  it.each([
    ['STOP', "You're in - I'll text you the schedule. Reply STOP anytime."],
    ['HELP', 'Text HELP if you get stuck.'],
    ['ARRET', 'Vous pouvez répondre ARRET en tout temps.'],
    ['ARRÊT', 'Répondez ARRÊT pour arrêter.'],
    ['AIDE', 'Écrivez AIDE au besoin.'],
    ['the opt-out line', 'See you Saturday. reply stop to opt out.'],
  ])('refuses a line that teaches %s', (_name, text) => {
    expect(acceptSpokenLine(text, [], strict)).toBeNull();
  });

  it('passes plain words about stopping (positive control)', () => {
    const text = "If you'd rather I stop texting, just tell me - no help needed.";
    expect(acceptSpokenLine(text, [], strict)).toBe(text);
  });

  it('leaves a line without an addendum on the acceptance it had', () => {
    const text = 'Reply STOP anytime.';
    expect(acceptSpokenLine(text, [])).toBe(text);
  });

  it('keeps a place that holds a keyword as a word, and refuses one taught around it', () => {
    const place = 'BUS STOP 14, King St';
    const line = `Pickup at 4:15 at ${place}.`;
    expect(acceptSpokenLine(line, [place], strict)).toBe(line);
    expect(acceptSpokenLine('Pickup at 4:15.', [place], strict)).toBeNull();
    expect(acceptSpokenLine(`${line} Reply STOP anytime.`, [place], strict)).toBeNull();
  });

  it('refuses a lowercase keyword taught as a reply', () => {
    expect(acceptSpokenLine('You can reply stop anytime.', [], strict)).toBeNull();
    const plain = 'Tell me if you want me to stop.';
    expect(acceptSpokenLine(plain, [], strict)).toBe(plain);
  });
});

describe('acceptSpokenLine: a slot the model writes for a link it never sees (VIL-706)', () => {
  const SLOT = '[[link]]';
  const line = `Forward this to them: ${SLOT} Only to them.`;

  it('passes a line with the slot exactly once (positive control)', () => {
    expect(acceptSpokenLine(line, [SLOT], { slot: SLOT })).toBe(line);
  });

  it.each([
    ['no slot', 'Forward this to them. Only to them.'],
    ['the slot twice', `${SLOT} and again ${SLOT}`],
    ['another slot beside it', `${SLOT} from [[name]]`],
    ['a changed slot', 'Forward this: [[ link ]]'],
    ['a typed link', `${SLOT} or try villagehale.com/text`],
    ['a word glued before it', `Forward this${SLOT} to them.`],
    ['a word glued after it', `Forward ${SLOT}now.`],
    ['a path glued after it', `Forward ${SLOT}/extra to them.`],
    ['a sentence glued after its full stop', `Forward ${SLOT}.Only to them.`],
  ])('refuses %s', (_name, text) => {
    expect(acceptSpokenLine(text, [SLOT], { slot: SLOT })).toBeNull();
  });

  it.each([
    `Here: ${SLOT}`,
    `Forward ${SLOT}.`,
    `Forward (${SLOT}), only to them.`,
    `Forward ${SLOT}\nOnly to them.`,
    `Want to forward ${SLOT}?`,
  ])('keeps a link that stands clear of its neighbours: %s', (text) => {
    expect(acceptSpokenLine(text, [SLOT], { slot: SLOT })).toBe(text);
  });
});

describe('acceptSpokenRequest: one acceptance for the writer, the fixture and the eval', () => {
  const taught = 'You can reply STOP anytime.';

  it('refuses a keyword on a door-addendum line and on a line that asks for the refusal', () => {
    expect(
      acceptSpokenRequest(taught, {
        purpose: 'join_welcome',
        language: 'en',
        addendum: 'door-line',
      }),
    ).toBeNull();
    expect(
      acceptSpokenRequest(taught, {
        purpose: 'coparent_welcome',
        language: 'en',
        refuseOptOutKeyword: true,
      }),
    ).toBeNull();
  });

  it('positive control: the same draft on a line that asks for neither keeps its acceptance', () => {
    expect(acceptSpokenRequest(taught, { purpose: 'coparent_welcome', language: 'en' })).toBe(
      taught,
    );
  });

  it('reads a request slot as a required piece', () => {
    const request = { purpose: 'join_invite_forward', language: 'en', slot: '[[link]]' };
    expect(acceptSpokenRequest('Forward this. Only to them.', request)).toBeNull();
    expect(acceptSpokenRequest('Forward [[link]] to them.', request)).toBe(
      'Forward [[link]] to them.',
    );
  });
});

describe('the spoken-line writer: what an addendum changes in the request', () => {
  /**
   * A client that records the request it was handed and then fails, as a down provider
   * would. Request mechanics only: no model output is stood in for, and the real writer
   * goes on to retry, hold the line and page.
   */
  function recordingDownClient(seen: Array<{ system: unknown; user: unknown }>) {
    return (): AgentClient =>
      ({
        messages: {
          create: async (params: { system?: unknown; messages?: Array<{ content?: unknown }> }) => {
            seen.push({ system: params.system, user: params.messages?.[0]?.content });
            throw new Error('provider down');
          },
        },
      }) as unknown as AgentClient;
  }

  function systemText(system: unknown): string {
    return (system as Array<{ text: string }>).map((block) => block.text).join('');
  }

  it('rides the addendum after spoken-line, keeps the user turn, and pages once when both attempts fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: Array<{ system: unknown; user: unknown }> = [];
    const pages: OpsPage[] = [];
    const writer = createSpokenLineWriter(recordingDownClient(seen), {
      page: async (page) => {
        pages.push(page);
        return 'paged';
      },
    });

    const line = await writer.write({
      purpose: 'caregiver_welcome',
      language: 'en',
      facts: { role: 'grandparent' },
      addendum: 'door-line',
    });

    expect(line).toBeNull();
    expect(seen).toHaveLength(2);
    const first = systemText(seen[0]?.system);
    expect(first.indexOf('# Write the line')).toBeGreaterThanOrEqual(0);
    expect(first.indexOf('# The join and caregiver doors')).toBeGreaterThan(
      first.indexOf('# Write the line'),
    );
    expect(JSON.parse(String(seen[0]?.user))).toEqual({
      purpose: 'caregiver_welcome',
      language: 'en',
      facts: { role: 'grandparent' },
      verbatim: [],
    });
    expect(pages).toEqual([{ site: 'spoken_line_unwritten', facts: { stage: 'after_retry' } }]);
  }, 30_000);

  it('sends spoken-line alone when there is no addendum (the bytes every other line keeps)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: Array<{ system: unknown; user: unknown }> = [];
    const writer = createSpokenLineWriter(recordingDownClient(seen), {
      page: async () => 'paged',
    });

    await writer.write({ purpose: 'group_welcome', language: 'en' });

    const system = systemText(seen[0]?.system);
    expect(system).toContain('# Write the line');
    expect(system).not.toContain('# The join and caregiver doors');
    expect(system).not.toContain('# Reminding a caregiver where to be');
  }, 30_000);

  it('hands the model a slot as a verbatim piece and adds no link to the user turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: Array<{ system: unknown; user: unknown }> = [];
    const writer = createSpokenLineWriter(recordingDownClient(seen), {
      page: async () => 'paged',
    });

    await writer.write({
      purpose: 'join_invite_forward',
      language: 'en',
      facts: { validForDays: '7' },
      slot: '[[link]]',
      addendum: 'door-line',
    });

    expect(JSON.parse(String(seen[0]?.user))).toEqual({
      purpose: 'join_invite_forward',
      language: 'en',
      facts: { validForDays: '7' },
      verbatim: ['[[link]]'],
    });
  }, 30_000);
});
