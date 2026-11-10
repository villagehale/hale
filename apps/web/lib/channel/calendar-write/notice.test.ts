import type { AgentClient } from '@hale/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calendarWriteNoticeEnabled,
  calendarWriteNoticeInput,
  calendarWriteNoticeRefusals,
  calendarWriteOutcome,
  composeCalendarWriteNotice,
} from './notice';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'calendar-write-notice', whenToUse: 'x', task: 'speak', tools: [] },
    instructions: 'speak',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;
const EVENT = { title: 'Swim lesson', when: 'Sat, Nov 7 at 10:00 AM', where: 'Y on Main' };
const LINK = 'https://app.villagehale.com/c/abc123';

describe('VIL-454 calendarWriteOutcome', () => {
  it('maps a written report by op', () => {
    const written = { status: 'written', googleEventId: 'g1' } as const;
    expect(calendarWriteOutcome('create', written)).toBe('added');
    expect(calendarWriteOutcome('update', written)).toBe('updated');
    expect(calendarWriteOutcome('delete', written)).toBe('removed');
  });

  it('names the skips the parent can act on', () => {
    expect(calendarWriteOutcome('create', { status: 'skipped', reason: 'not_connected' })).toBe(
      'no_calendar',
    );
    expect(calendarWriteOutcome('create', { status: 'skipped', reason: 'scope_missing' })).toBe(
      'needs_permission',
    );
    expect(calendarWriteOutcome('create', { status: 'skipped', reason: 'token_unavailable' })).toBe(
      'needs_reconnect',
    );
    expect(calendarWriteOutcome('create', { status: 'failed', reason: 'google_error' })).toBe(
      'could_not_write',
    );
  });

  it.each([
    'flag_off',
    'not_configured',
    'already_present',
    'not_ours',
    'event_missing',
    'ambiguous',
  ] as const)('is no notice for %s (a re-driven pass never texts twice)', (reason) => {
    expect(calendarWriteOutcome('create', { status: 'skipped', reason })).toBeNull();
  });
});

describe('VIL-454 calendarWriteNoticeInput', () => {
  it('drops a link a success does not need', () => {
    const input = calendarWriteNoticeInput({
      op: 'create',
      report: { status: 'written', googleEventId: 'g1' },
      event: EVENT,
      connectLink: LINK,
      language: 'en',
    });
    expect(input?.connectLink).toBeNull();
  });

  it('refuses a link outcome with no link to give', () => {
    expect(
      calendarWriteNoticeInput({
        op: 'create',
        report: { status: 'skipped', reason: 'not_connected' },
        event: EVENT,
        connectLink: null,
        language: 'fr',
      }),
    ).toBeNull();
  });
});

describe('VIL-454 calendarWriteNoticeRefusals (structure only)', () => {
  const base = { outcome: 'added' as const, event: EVENT, connectLink: null, language: 'en' };
  it('refuses empty and stray links', () => {
    expect(calendarWriteNoticeRefusals('  ', base)).toEqual(['empty']);
    expect(calendarWriteNoticeRefusals('Done, see https://x.test', base)).toContain('carries_link');
  });
  it('requires the handed link exactly and no other', () => {
    const linked = { ...base, outcome: 'no_calendar' as const, connectLink: LINK };
    expect(calendarWriteNoticeRefusals('No calendar yet.', linked)).toContain('link_missing');
    expect(
      calendarWriteNoticeRefusals(`Connect here ${LINK} or https://evil.test`, linked),
    ).toContain('other_link');
    expect(
      calendarWriteNoticeRefusals(`Nothing went on, but ${LINK} connects one.`, linked),
    ).toEqual([]);
  });
});

describe('VIL-454 composeCalendarWriteNotice', () => {
  const input = { outcome: 'added' as const, event: EVENT, connectLink: null, language: 'en' };
  beforeEach(() => vi.mocked(forceToolJson).mockReset());

  it('returns the first usable draft', async () => {
    vi.mocked(forceToolJson).mockResolvedValueOnce({
      value: { text: 'Swim is on your calendar.' },
    } as never);
    expect(await composeCalendarWriteNotice(CLIENT, input)).toBe('Swim is on your calendar.');
  });

  it('retries a refused draft once, then sends nothing', async () => {
    vi.mocked(forceToolJson).mockResolvedValue({ value: { text: 'see https://x.test' } } as never);
    expect(await composeCalendarWriteNotice(CLIENT, input)).toBeNull();
    expect(forceToolJson).toHaveBeenCalledTimes(2);
  });

  it('is off unless exactly true', () => {
    expect(calendarWriteNoticeEnabled({})).toBe(false);
    expect(calendarWriteNoticeEnabled({ CALENDAR_WRITE_NOTICE_ENABLED: 'yes' })).toBe(false);
    expect(calendarWriteNoticeEnabled({ CALENDAR_WRITE_NOTICE_ENABLED: 'true' })).toBe(true);
  });
});
