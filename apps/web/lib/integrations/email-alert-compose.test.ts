import { beforeEach, describe, expect, it, vi } from 'vitest';

const forceToolJson = vi.fn();
vi.mock('~/lib/pipeline/structured', () => ({
  forceToolJson: (...args: unknown[]) => forceToolJson(...args),
}));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({ instructions: 'SKILL', meta: { task: 'draft' } }),
}));

import type { AgentClient } from '@hale/agent';
import {
  EMAIL_ALERT_MAX_ATTEMPTS,
  type EmailAlertFacts,
  composeEmailAlertText,
  emailAlertRefusals,
} from './email-alert-compose';

const SECRET_TITLE = 'Dr. Patel therapy intake';
const SECRET_SENDER = 'Northside Counselling';

const FACTS: EmailAlertFacts = {
  kind: 'new_event',
  from: SECRET_SENDER,
  what: SECRET_TITLE,
  when: { was: null, now: { date: '2026-10-02', isoWeekday: 5, time: '09:00', relativeDay: null } },
  where: null,
  categoryOnly: false,
  fromCalendar: false,
  going: null,
  notOnTheirCalendarYet: true,
  haleCanAddIt: false,
  recentParentWords: [],
  language: 'en',
  passport: null,
};

const client = {} as AgentClient;

describe('composeEmailAlertText', () => {
  let spies: Array<ReturnType<typeof vi.spyOn>>;
  beforeEach(() => {
    forceToolJson.mockReset();
    spies = (['error', 'warn', 'info', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
  });
  const logged = (): string => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

  it('returns the model text when the first draft passes', async () => {
    forceToolJson.mockResolvedValueOnce({ value: { text: '  The text.  ', offered: false } });
    await expect(composeEmailAlertText(client, FACTS, 'fam')).resolves.toEqual({
      text: 'The text.',
      offered: false,
    });
    expect(forceToolJson).toHaveBeenCalledTimes(1);
  });

  it('retries once, then returns null: two failures mean nothing is sent', async () => {
    forceToolJson.mockRejectedValue(new Error(`model said ${SECRET_TITLE}`));
    await expect(composeEmailAlertText(client, FACTS, 'fam')).resolves.toBeNull();
    expect(EMAIL_ALERT_MAX_ATTEMPTS).toBe(2);
    expect(forceToolJson).toHaveBeenCalledTimes(2);
  });

  it('a refused draft counts as a failed attempt', async () => {
    forceToolJson.mockResolvedValue({ value: { text: `${SECRET_TITLE}? Want it?` } });
    await expect(composeEmailAlertText(client, FACTS, 'fam')).resolves.toBeNull();
    expect(forceToolJson).toHaveBeenCalledTimes(2);
  });

  it('logs no email content: not the title, the sender, the draft or the error text', async () => {
    forceToolJson
      .mockResolvedValueOnce({ value: { text: `${SECRET_TITLE} https://x.example ?` } })
      .mockRejectedValueOnce(new Error(`boom ${SECRET_SENDER}`));
    await expect(composeEmailAlertText(client, FACTS, 'fam')).resolves.toBeNull();
    const lines = logged();
    expect(lines).not.toContain(SECRET_TITLE);
    expect(lines).not.toContain(SECRET_SENDER);
    expect(lines).not.toContain('x.example');
    expect(lines).not.toContain('boom');
    expect(lines).toContain('email_alert_unwritten');
  });
});

describe('emailAlertRefusals', () => {
  it('refuses structure only, never wording', () => {
    expect(emailAlertRefusals('', FACTS)).toEqual(['empty']);
    expect(emailAlertRefusals('See https://a.example', FACTS)).toContain('link');
    expect(emailAlertRefusals('Write to a@b.ca', FACTS)).toContain('email_address');
    expect(emailAlertRefusals('Add it?', FACTS)).toContain('unbacked_question');
    // A question is backed only when the writer OFFERED and Hale can keep it.
    expect(emailAlertRefusals('Add it?', { ...FACTS, haleCanAddIt: true }, true)).toEqual([]);
    expect(emailAlertRefusals('Add it?', { ...FACTS, haleCanAddIt: true }, false)).toContain(
      'unbacked_question',
    );
    expect(emailAlertRefusals('I can add it.', FACTS, true)).toContain('unbacked_offer');
    expect(emailAlertRefusals('x'.repeat(481), FACTS)).toContain('over_char_cap');
    expect(emailAlertRefusals('Picture day moved to Friday.', FACTS)).toEqual([]);
  });
});
