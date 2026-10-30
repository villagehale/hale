import { describe, expect, it, vi } from 'vitest';
import { EFUN_GONE, TORONTO_REC_PORTAL, writeRecMorningReply } from './index';

describe('VIL-508 · rec-morning text is the model, or nothing', () => {
  it('hands the reviewed facts to the model and keeps the portal verbatim', async () => {
    const write = vi.fn(async () => 'model words');
    const text = await writeRecMorningReply('is efun still a thing?', new Date(), null, write);
    expect(text).toBe('model words');
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'rec_morning',
        facts: expect.objectContaining({ answer: EFUN_GONE }),
        verbatim: expect.arrayContaining([TORONTO_REC_PORTAL.replace(/[.,]+$/, '')]),
      }),
    );
  });

  it('sends nothing when the model writes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = await writeRecMorningReply(
      'is efun still a thing?',
      new Date(),
      null,
      async () => null,
    );
    expect(text).toBeNull();
    vi.restoreAllMocks();
  });

  it('never calls the model for a text that is not a rec-morning question', async () => {
    const write = vi.fn(async () => 'x');
    expect(await writeRecMorningReply('what time is dinner', new Date(), null, write)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
