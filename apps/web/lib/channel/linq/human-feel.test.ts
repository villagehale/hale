import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The helpers that put something other than a reply on a parent's phone stay
 * in the transport. The v1 path may start a typing bubble; it must not react,
 * attach media, or share a contact card on its own.
 */

const ROUTER = fileURLToPath(new URL('../router/route.ts', import.meta.url));
const INBOUND = fileURLToPath(new URL('./inbound.ts', import.meta.url));

describe('iMessage human-feel wiring', () => {
  it('starts typing before the search and the coach, and stops in the send', () => {
    const source = readFileSync(ROUTER, 'utf8');
    expect(source).toContain("signalImessageTyping(route, 'start'");
    expect(source).toContain('LINQ_TYPING_REFRESH_MS');
    expect(source).toContain('beforeSend: stopTyping');
    const startAt = source.indexOf("signalImessageTyping(route, 'start'");
    const searchAt = source.indexOf('deps.searchWeekdays');
    const coachAt = source.indexOf('return await runAgentTurn');
    expect(startAt).toBeGreaterThan(-1);
    expect(startAt).toBeLessThan(searchAt);
    expect(startAt).toBeLessThan(coachAt);
  });

  it('does not call the card, the tapback, or a media part from the v1 doors', () => {
    const router = readFileSync(ROUTER, 'utf8');
    const inbound = readFileSync(INBOUND, 'utf8');
    for (const source of [router, inbound]) {
      expect(source).not.toContain('shareLinqContactCard(');
      expect(source).not.toContain('reactToLinqMessage(');
      expect(source).not.toContain('sendLinqParts(');
    }
  });
});
