import { describe, expect, it, vi } from 'vitest';
import {
  EFUN_GONE,
  TORONTO_REC_PORTAL,
  recMorningReply,
  resolveRecMorningWhere,
  writeRecMorningIntakeReply,
  writeRecMorningReply,
} from './index';

/** A family whose stored postal is a Toronto FSA: rec-morning answers only a GTA family. */
const TORONTO_FSA = 'M5V';
const AT_TORONTO_FSA = resolveRecMorningWhere({
  city: null,
  postal: TORONTO_FSA,
  country: null,
  province: null,
  timeZone: 'America/Toronto',
});

describe('VIL-508 · rec-morning text is the model, or nothing', () => {
  it('hands the reviewed facts to the model and keeps the portal verbatim', async () => {
    const write = vi.fn(async () => 'model words');
    const text = await writeRecMorningReply(
      'is efun still a thing?',
      new Date(),
      AT_TORONTO_FSA,
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
      AT_TORONTO_FSA,
      null,
      async () => null,
    );
    expect(text).toBeNull();
    vi.restoreAllMocks();
  });

  it('intake forwards a stored language and passes null when there is none', async () => {
    const write = vi.fn(async () => 'model words');
    await writeRecMorningIntakeReply(
      {
        parentWords: 'is efun still a thing?',
        pendingAsk: '',
        postal: TORONTO_FSA,
        language: 'zh',
      },
      write,
    );
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ language: 'zh' }));
    write.mockClear();
    await writeRecMorningIntakeReply(
      { parentWords: 'is efun still a thing?', pendingAsk: '', postal: TORONTO_FSA },
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
      await writeRecMorningReply('what time is dinner', new Date(), AT_TORONTO_FSA, null, write),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});

/**
 * VIL-545. "Can you loop in Sam about Saturday's swim pickup?" passes the word test for
 * a city family (it says "swim"), and the lane used to claim it and answer with the
 * city's registration morning, in the group and in 1:1. The word test now only picks
 * which facts to read; the model reads whether those facts answer the text, and only
 * `answers` lets the lane speak. Which reading a text gets is pinned by the
 * rec-morning-read eval; this pins what code does with each.
 */
describe('VIL-545 · the lane speaks only when the model reads that its facts answer the text', () => {
  const PICKUP = "Hale, can you loop in Sam about Saturday's swim pickup? I can't make it.";
  const reading = (value: 'answers' | 'other' | null) => vi.fn(async () => value);

  it('the pickup text passes the word test, so only the read can keep it out', () => {
    expect(recMorningReply(PICKUP, new Date(), AT_TORONTO_FSA)).not.toBeNull();
  });

  it('a text the facts do not answer is left to the coach, and no line is written', async () => {
    const write = vi.fn(async () => 'model words');
    const read = reading('other');
    expect(
      await writeRecMorningReply(PICKUP, new Date(), AT_TORONTO_FSA, null, write, read),
    ).toBeNull();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ text: PICKUP, facts: expect.stringContaining(TORONTO_REC_PORTAL) }),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('positive control: a text the facts answer is written', async () => {
    const write = vi.fn(async () => 'model words');
    const ask = 'when does swim registration open?';
    expect(
      await writeRecMorningReply(ask, new Date(), AT_TORONTO_FSA, null, write, reading('answers')),
    ).toBe('model words');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a failed read sends nothing from this lane and names it in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.fn(async () => 'model words');
    expect(
      await writeRecMorningReply(PICKUP, new Date(), AT_TORONTO_FSA, null, write, reading(null)),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      { outcome: 'read_failed' },
      expect.stringContaining('rec-morning'),
    );
    vi.restoreAllMocks();
  });

  it('intake reads too: a pickup text mid-signup is not answered with a registration date', async () => {
    const write = vi.fn(async () => 'model words');
    expect(
      await writeRecMorningIntakeReply(
        { parentWords: PICKUP, pendingAsk: '', postal: TORONTO_FSA },
        write,
        reading('other'),
      ),
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
