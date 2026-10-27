import { beforeEach, describe, expect, it, vi } from 'vitest';

const forceToolJson = vi.fn();
vi.mock('~/lib/pipeline/structured', () => ({
  forceToolJson: (...args: unknown[]) => forceToolJson(...args),
}));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({ instructions: 'SKILL', meta: { task: 'speak' } }),
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
  when: { was: null, now: 'Friday, Oct 2 at 9:00 a.m.' },
  where: null,
  categoryOnly: false,
  fromCalendar: false,
  going: null,
  ask: null,
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
    forceToolJson.mockResolvedValueOnce({ value: { text: '  The text.  ' } });
    await expect(composeEmailAlertText(client, FACTS, 'fam')).resolves.toBe('The text.');
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
    expect(emailAlertRefusals('Add it?', { ...FACTS, ask: 'add_to_week' })).toEqual([]);
    expect(emailAlertRefusals('x'.repeat(481), FACTS)).toContain('over_char_cap');
    expect(emailAlertRefusals('Picture day moved to Friday.', FACTS)).toEqual([]);
  });
});
