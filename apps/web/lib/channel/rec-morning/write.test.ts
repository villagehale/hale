import { describe, expect, it, vi } from 'vitest';
import {
  EFUN_GONE,
  TORONTO_REC_PORTAL,
  writeRecMorningIntakeReply,
  writeRecMorningReply,
} from './index';

describe('VIL-508 · rec-morning text is the model, or nothing', () => {
  it('hands the reviewed facts to the model and keeps the portal verbatim', async () => {
    const write = vi.fn(async () => 'model words');
    const text = await writeRecMorningReply(
      'is efun still a thing?',
      new Date(),
      null,
      'fr',
      write,
    );
    expect(text).toBe('model words');
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'rec_morning',
        language: 'fr',
        facts: expect.objectContaining({
          answer: EFUN_GONE,
          parentWords: 'is efun still a thing?',
        }),
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
      null,
      async () => null,
    );
    expect(text).toBeNull();
    vi.restoreAllMocks();
  });

  it('intake forwards a stored language and passes null when there is none', async () => {
    const write = vi.fn(async () => 'model words');
    await writeRecMorningIntakeReply(
      { parentWords: 'is efun still a thing?', pendingAsk: '', language: 'zh' },
      write,
    );
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ language: 'zh' }));
    write.mockClear();
    await writeRecMorningIntakeReply(
      { parentWords: 'is efun still a thing?', pendingAsk: '' },
      write,
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        language: null,
        facts: expect.objectContaining({ parentWords: 'is efun still a thing?' }),
      }),
    );
  });

  it('never calls the model for a text that is not a rec-morning question', async () => {
    const write = vi.fn(async () => 'x');
    expect(
      await writeRecMorningReply('what time is dinner', new Date(), null, null, write),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
