import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpsPage } from '~/lib/monitoring/failure-page';
import { acceptSpokenLine, createSpokenLineWriter } from './spoken-line';

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
});
