import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_SCOPED_SEND_KEYS_ENV, familySendKey, providerPollKey } from './family-send-key';
import { midActivityAskRef } from './mid-activity/claim';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(32);
const AT = '2026-09-25T19:00:00.000Z';

afterEach(() => {
  vi.unstubAllEnvs();
});

const SHAPES: ReadonlyArray<readonly [lane: string, oldKey: string, newKey: string]> = [
  ['who-takes', `linq-group:who-takes:evt-1:${AT}`, `linq-group:${FAMILY}:who-takes:evt-1:${AT}`],
  ['conflict', `linq-group:conflict:evt-1:${AT}`, `linq-group:${FAMILY}:conflict:evt-1:${AT}`],
  ['handoff', `linq-group:handoff:evt-1:${AT}`, `linq-group:${FAMILY}:handoff:evt-1:${AT}`],
  ['kids', 'linq-group:kids:evt-1:evt-2', `linq-group:${FAMILY}:kids:evt-1:evt-2`],
  ['followup', 'linq-group:followup:evt-1', `linq-group:${FAMILY}:followup:evt-1`],
  ['clash', `linq-group:clash:${HASH}`, `linq-group:${FAMILY}:clash:${HASH}`],
  [
    'said, no candidate',
    'mid-activity:ask:said:2026-06-02:none',
    `mid-activity:ask:said:${FAMILY}#2026-06-02:none`,
  ],
  [
    'said, with a candidate',
    `mid-activity:ask:said:2026-06-02:${CANDIDATE}`,
    `mid-activity:ask:said:${FAMILY}#2026-06-02:${CANDIDATE}`,
  ],
  ['quiet notice', 'linq:group_quiet_notice:chat-1', `linq:group_quiet_notice:${FAMILY}:chat-1`],
];

describe('familySendKey with the flag on', () => {
  it.each(SHAPES)('%s: the old key maps to the family key', (_lane, oldKey, newKey) => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    expect(familySendKey(oldKey, FAMILY)).toEqual({ dedupeKey: newKey, legacyDedupeKey: oldKey });
  });

  it.each(SHAPES)('%s: the family key maps to the same pair', (_lane, oldKey, newKey) => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    expect(familySendKey(newKey, FAMILY)).toEqual({ dedupeKey: newKey, legacyDedupeKey: oldKey });
  });

  it.each([
    ['the cross-parent 1:1 clash key', `linq-group:clash:${HASH}:1to1:${CANDIDATE}`],
    ['an unknown group kind', 'linq-group:unknown:x'],
    ['a nudge key', 'nudge:weather:w41'],
    ['a chat-scoped intro key', 'linq:multi_family_intro:chat-1'],
    ['a mid-activity plan key', 'mid-activity:ask:plan:evt-1:none'],
    ['a key that already names the family', `registration_sequence:${FAMILY}:x`],
  ])('leaves %s as passed', (_name, key) => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    expect(familySendKey(key, FAMILY)).toEqual({ dedupeKey: key, legacyDedupeKey: null });
  });

  it("does not strip the family id from anywhere but the key's own slot", () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    const oldKey = `linq-group:kids:${FAMILY}:evt-2`;
    expect(familySendKey(oldKey, FAMILY)).toEqual({
      dedupeKey: `linq-group:${FAMILY}:kids:${FAMILY}:evt-2`,
      legacyDedupeKey: oldKey,
    });
  });
});

describe('familySendKey with the flag anything but exact true', () => {
  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['TRUE', 'TRUE'],
    ['true with a newline', 'true\n'],
    ['1', '1'],
  ])('%s: the key as passed, no legacy read', (_name, value) => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, value);
    for (const [, oldKey, newKey] of SHAPES) {
      expect(familySendKey(oldKey, FAMILY)).toEqual({ dedupeKey: oldKey, legacyDedupeKey: null });
      expect(familySendKey(newKey, FAMILY)).toEqual({ dedupeKey: newKey, legacyDedupeKey: null });
    }
  });
});

describe('the said key still parses for the answer pass', () => {
  it('reads the family shape with no candidate', () => {
    expect(midActivityAskRef(`mid-activity:ask:said:${FAMILY}#2026-06-02:none`)).toEqual({
      kind: 'said',
      candidateId: null,
    });
  });

  it('reads the family shape with a candidate', () => {
    expect(midActivityAskRef(`mid-activity:ask:said:${FAMILY}#2026-06-02:${CANDIDATE}`)).toEqual({
      kind: 'said',
      candidateId: CANDIDATE,
    });
  });

  it('a fourth colon part is still no ask, which is why the family id is joined by #', () => {
    expect(midActivityAskRef(`mid-activity:ask:said:${FAMILY}:2026-06-02:none`)).toBeNull();
  });
});

describe('providerPollKey', () => {
  it('is the plain key when the send has no family form', () => {
    expect(providerPollKey({ dedupeKey: `linq-group:clash:${HASH}`, legacyDedupeKey: null })).toBe(
      `poll:linq-group:clash:${HASH}`,
    );
  });

  it('never carries the family id to Linq, and differs per family', () => {
    const mine = providerPollKey({
      dedupeKey: `linq-group:${FAMILY}:clash:${HASH}`,
      legacyDedupeKey: `linq-group:clash:${HASH}`,
    });
    const theirs = providerPollKey({
      dedupeKey: `linq-group:${CANDIDATE}:clash:${HASH}`,
      legacyDedupeKey: `linq-group:clash:${HASH}`,
    });
    expect(mine).toMatch(/^poll:[0-9a-f]{64}$/);
    expect(mine).not.toContain(FAMILY);
    expect(mine).not.toBe(theirs);
  });
});
