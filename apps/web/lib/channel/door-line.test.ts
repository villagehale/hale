import { afterEach, describe, expect, it } from 'vitest';
import { DOOR_LINE_PURPOSES, joinDoorModelCopyEnabled } from './door-line';
import { speak } from './spoken-line';

afterEach(() => {
  process.env.JOIN_DOOR_MODEL_COPY_ENABLED = '';
  process.env.POSTHOG_FLAGS_ENABLED = '';
});

describe('joinDoorModelCopyEnabled', () => {
  it('is on only for the exact value true', () => {
    expect(joinDoorModelCopyEnabled({})).toBe(false);
    expect(joinDoorModelCopyEnabled({ JOIN_DOOR_MODEL_COPY_ENABLED: 'true' })).toBe(true);
    for (const value of ['true\n', ' true', 'true ', 'TRUE', 'True', '1', 'on', 'yes', '']) {
      expect(joinDoorModelCopyEnabled({ JOIN_DOOR_MODEL_COPY_ENABLED: value })).toBe(false);
    }
  });
});

describe('door line fixtures', () => {
  it('writes every door purpose without teaching STOP or HELP', async () => {
    const samples: Record<string, Record<string, string>> = {
      join_invite_forward: { link: 'https://www.villagehale.com/text?s=join-abc' },
      join_welcome: { inviterName: 'Ana' },
      caregiver_welcome: { role: 'grandparent' },
      caregiver_invite_sent: { name: 'grandma' },
      caregiver_invite_dropped: { name: 'grandma' },
      caregiver_scoped_reply: { parentName: 'Sam' },
    };
    for (const purpose of DOOR_LINE_PURPOSES) {
      const verbatim =
        purpose === 'join_invite_forward' ? [samples[purpose]?.link ?? ''] : undefined;
      const line = await speak({
        purpose,
        language: 'en',
        facts: samples[purpose],
        verbatim,
      });
      expect(line, purpose).toEqual(expect.any(String));
      expect(line, purpose).not.toMatch(/\b(STOP|HELP|ARRET|AIDE)\b/);
    }
  });
});
