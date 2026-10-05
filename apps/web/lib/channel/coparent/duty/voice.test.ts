import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSpokenLineBody, fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { type DutyLineRequest, dutyLineInput, speakDutyBubble, speakDutyLine } from './voice';

const REASK: DutyLineRequest = {
  kind: 'reask',
  kid: 'Maya',
  event: 'swim',
  day: 'Tuesday',
  time: '3:00pm',
};
const NIGHT: DutyLineRequest = {
  kind: 'night_before',
  owner: 'Sam',
  kid: 'Maya',
  event: 'swim',
  time: '3:00pm',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('speakDutyBubble', () => {
  it('joins one spoken line per request with a line break, in order', async () => {
    const voice = fakeSpokenLineComposer();
    const bubble = await speakDutyBubble(voice, [NIGHT, REASK], 'en');
    expect(bubble.unsent).toBeNull();
    expect(bubble.text).toBe(
      [
        fakeSpokenLineBody(dutyLineInput(NIGHT, 'en')),
        fakeSpokenLineBody(dutyLineInput(REASK, 'en')),
      ].join('\n'),
    );
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['night_before', 'reask']);
  });

  it('is all or nothing: one line the model cannot write leaves the whole bubble unsent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const voice = fakeSpokenLineComposer({
      body: (input) => {
        calls += 1;
        if (input.kind === 'reask') return 'Sorry, something went wrong.';
        return fakeSpokenLineBody(input);
      },
    });
    const bubble = await speakDutyBubble(voice, [NIGHT, REASK], 'en');
    expect(bubble).toEqual({
      text: null,
      source: 'unsent',
      unsent: { kind: 'reask', fallback: 'unusable' },
    });
    // The first line was written and the second tried twice (full, then short) before
    // the bubble gave up; nothing is sent in its place.
    expect(calls).toBe(3);
  });

  it('names the bubble unsent when no voice is wired, and says so to #ops', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const paged: string[] = [];
    const bubble = await speakDutyBubble(undefined, [REASK], 'en', {
      page: async (text) => {
        paged.push(text);
      },
    });
    expect(bubble).toEqual({
      text: null,
      source: 'unsent',
      unsent: { kind: 'reask', fallback: 'voice_unavailable' },
    });
    expect(paged).toHaveLength(1);
  });

  it('refuses an empty bubble as a programming error rather than sending nothing silently', async () => {
    await expect(speakDutyBubble(fakeSpokenLineComposer(), [], 'en')).rejects.toThrow(
      /nothing to say/,
    );
  });
});

describe('speakDutyLine', () => {
  it('speaks one line on the duty-voice skill', async () => {
    const voice = fakeSpokenLineComposer();
    const spoken = await speakDutyLine(voice, REASK, 'fr');
    expect(spoken.source).toBe('composed');
    expect(voice.calls[0]?.input).toMatchObject({
      skill: 'duty-voice',
      kind: 'reask',
      language: 'fr',
    });
  });
});
