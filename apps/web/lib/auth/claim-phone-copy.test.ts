import { describe, expect, it } from 'vitest';
import { namesKeyword } from '~/lib/channel/no-stop-keyword';
import { claimCodeNote } from './claim-phone-copy';

describe('claimCodeNote (VIL-744)', () => {
  it("keeps today's sentence with the flag off", () => {
    expect(claimCodeNote(false)).toBe(
      'Nothing yet? It can take a minute. If you once replied STOP to Hale, reply START in that thread first.',
    );
  });

  it('names no keyword with the flag on, and says how a stopped number comes back', () => {
    const note = claimCodeNote(true);
    expect(namesKeyword(note)).toBeNull();
    expect(note).not.toMatch(/STOP|START/);
    expect(note).toBe(
      'Nothing yet? It can take a minute. If you once told Hale to stop texting you, text Hale that you want to start again, in your own words, then send a new code.',
    );
  });
});
