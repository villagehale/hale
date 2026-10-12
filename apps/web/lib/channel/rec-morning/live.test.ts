import { describe, expect, it } from 'vitest';
import { liveRecMorningIntakeReply, liveRecMorningReply } from './live';
import type { RegistrationReader } from '~/lib/registration/read';
import { INTAKE_MAX_REPLY_CHARS, recMorningReturnLine } from './copy';

const now = new Date('2026-10-10T12:00:00Z');
// A verified read exercises SMS formatting, not extraction quality.
const reader: RegistrationReader = async (target) => ({
  sourceUrl: target.sourceUrl,
  checkedAt: now,
  timeZone: 'America/Toronto',
  reader: 'ai',
  status: 'verified',
  dates: [{ kind: 'general_open', date: '2026-10-20', time: null, evidence: ['source date'] }],
});
describe('live rec-morning SMS', () => {
  it('reads the requested known season, not the first seed cycle', async () => {
    const cycles: string[] = [];
    await liveRecMorningReply('Markham fall swim registration', now, null, async (target, at) => {
      cycles.push(target.cycleLabel);
      return reader(target, at);
    });
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.every((cycle) => /fall/i.test(cycle))).toBe(true);
  });
  it('keeps the intake date/zone and outstanding ask inside its existing budget', async () => {
    const pendingAsk = 'ages';
    const reply = await liveRecMorningIntakeReply(
      { parentWords: 'Markham swim registration', pendingAsk, now },
      async (target, at) => ({
        ...(await reader(target, at)),
        sourceUrl: `${target.sourceUrl}?${'x'.repeat(200)}`,
      }),
    );
    expect(reply).toContain('2026-10-20');
    expect(reply).toContain('America/Toronto');
    expect(reply).toContain(recMorningReturnLine(pendingAsk));
    expect(reply).not.toContain('https://');
    expect(reply!.length).toBeLessThanOrEqual(INTAKE_MAX_REPLY_CHARS);
  });
  it('a failed read never substitutes the static seeded date', async () => {
    const reply = await liveRecMorningReply(
      'Markham swim registration',
      now,
      null,
      async (target) => ({
        sourceUrl: target.sourceUrl,
        checkedAt: now,
        timeZone: target.timeZone,
        reader: 'ai',
        status: 'unreadable',
        reason: 'fetch_failed',
      }),
    );
    expect(reply).toContain("couldn't verify");
    expect(reply).not.toContain('2026-');
  });
});
