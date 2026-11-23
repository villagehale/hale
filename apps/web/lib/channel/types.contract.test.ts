import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import { CALENDAR_CANCEL_SMS_TEMPLATE_KEY } from '~/lib/loop/templates/calendar-cancel/sms';
import { CALENDAR_INVITE_SMS_TEMPLATE_KEY } from '~/lib/loop/templates/calendar-invite/sms';
import { CAREGIVER_REMINDER_TEMPLATE_KEY } from '~/lib/loop/templates/caregiver/keys';
import { REMINDER_TEMPLATE_KEY, loopTemplateRenderer } from '~/lib/loop/templates/registry';
import { type DispatchPorts, dispatchLoopMessage } from './dispatch';
import { fakeChannel } from './fakes';
import type { LoopMessage } from './types';

/**
 * VIL-229 · the loop voice contract, as corrected in VIL-706 (types.ts): a null voice
 * HOLDS the send. There is no deterministic fallback for a line the model did not write.
 *
 * The compose stages enqueue nothing when the model writes nothing (the reminder run's
 * `unwritten` drop, the calendar invite's `compose_deferred`; their own tests pin those).
 * This file pins the last line of defence behind them, through the REAL template registry
 * and the REAL dispatch: a payload that reaches the renderer without its composed words
 * is refused, and nothing reaches the channel. Deterministic seam, no model involved.
 */

const CAREGIVER_FLAG = 'CAREGIVER_REMINDER_MODEL_COPY_ENABLED';
const TZ = 'America/Toronto';
const NOON = new Date('2026-07-25T16:00:00Z'); // 12:00 EDT
const ICS = 'https://www.villagehale.com/ics/e1.ics?sig=abc';

/** What each template's payload looks like when its compose stage wrote nothing. */
const UNWRITTEN: Record<string, Record<string, unknown>> = {
  [REMINDER_TEMPLATE_KEY]: {
    offset: '-PT1H',
    timeZone: TZ,
    events: [
      { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:15:00Z', childId: null },
    ],
    children: [],
    deepLink: null,
    unsubscribeUrl: null,
  },
  [CALENDAR_INVITE_SMS_TEMPLATE_KEY]: {
    familyEventId: 'e1',
    summary: 'Swim class',
    when: 'Sat, Jul 25 at 4:15 PM',
    url: ICS,
    line: '',
  },
  [CALENDAR_CANCEL_SMS_TEMPLATE_KEY]: { when: 'Sat, Jul 25 at 4:15 PM', line: '' },
  [CAREGIVER_REMINDER_TEMPLATE_KEY]: {
    offset: '-PT1H',
    timeZone: TZ,
    events: [
      { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T20:15:00Z', location: null },
    ],
  },
  // An unregistered key renders through the seam's default renderer.
  'unregistered-template': {},
};

/** The same payloads, with the words the model wrote. */
function written(templateKey: string): Record<string, unknown> {
  const base = UNWRITTEN[templateKey] ?? {};
  if (templateKey === CALENDAR_INVITE_SMS_TEMPLATE_KEY) {
    return { ...base, line: `Swim class is Saturday at 4:15. Tap to add it: ${ICS}` };
  }
  if (templateKey === CALENDAR_CANCEL_SMS_TEMPLATE_KEY) {
    return { ...base, line: "Saturday's swim class at 4:15 is cancelled." };
  }
  if (templateKey === 'unregistered-template') return { text: 'Swim class is at 4:15.' };
  return { ...base, texts: ['Swim class is at 4:15 today.'] };
}

function message(templateKey: string, payload: Record<string, unknown>): LoopMessage {
  return {
    templateKey,
    familyId: 'fam-1',
    parentUserId: 'user-1',
    category: 'reminder',
    urgency: 'normal',
    payload,
    channel: 'sms',
  };
}

function ports(channel = fakeChannel('sms')): DispatchPorts {
  return {
    now: () => NOON,
    loadPrefs: async () => DEFAULT_LOOP_PREFS,
    loadParent: async () => ({ timezone: TZ }),
    parentPhone: async () => null,
    smsConsentLive: async () => true,
    activeDedupe: async () => false,
    chatService: async () => null,
    record: async () => 'row-1',
    audit: async () => {},
    capture: async () => 'sent',
    threadMessage: async () => {},
    channels: { sms: channel },
    renderer: loopTemplateRenderer,
    claimShadow: { dispatch: () => 'off' },
    claimEnforce: { enforces: () => false, decide: async () => ({ status: 'off' as const }) },
  };
}

const KEYS = Object.keys(UNWRITTEN);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the loop voice contract: a null voice holds the send', () => {
  it.each(KEYS)('%s refuses a payload whose composed words are missing', (templateKey) => {
    vi.stubEnv(CAREGIVER_FLAG, 'true');
    expect(() =>
      loopTemplateRenderer.render(
        message(templateKey, UNWRITTEN[templateKey] ?? {}),
        'sms',
        'first_name',
      ),
    ).toThrow();
  });

  it.each(KEYS)('%s sends nothing through the dispatch without its composed words', async (key) => {
    vi.stubEnv(CAREGIVER_FLAG, 'true');
    const sms = fakeChannel('sms');
    await expect(
      dispatchLoopMessage(message(key, UNWRITTEN[key] ?? {}), ports(sms)),
    ).rejects.toThrow();
    expect(sms.calls).toEqual([]);
  });

  it.each(KEYS)('positive control: %s sends the words the model wrote', async (key) => {
    vi.stubEnv(CAREGIVER_FLAG, 'true');
    const sms = fakeChannel('sms');
    const result = await dispatchLoopMessage(message(key, written(key)), ports(sms));
    expect(result.legs).toEqual([expect.objectContaining({ channel: 'sms', outcome: 'sent' })]);
    expect(sms.calls).toHaveLength(1);
  });

  it('names the one template that still renders code-built words while its flag is off', () => {
    vi.stubEnv(CAREGIVER_FLAG, '');
    const rendered = loopTemplateRenderer.render(
      message(CAREGIVER_REMINDER_TEMPLATE_KEY, UNWRITTEN[CAREGIVER_REMINDER_TEMPLATE_KEY] ?? {}),
      'sms',
      'first_name',
    );
    expect(rendered.modelWritten).toBe(false);
    // Every other template refuses a payload without its words, with or without the flag.
    for (const key of KEYS.filter((k) => k !== CAREGIVER_REMINDER_TEMPLATE_KEY)) {
      expect(() =>
        loopTemplateRenderer.render(message(key, UNWRITTEN[key] ?? {}), 'sms', 'first_name'),
      ).toThrow();
    }
  });
});
