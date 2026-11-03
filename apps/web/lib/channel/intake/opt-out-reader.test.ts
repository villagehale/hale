import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type OptOutReader,
  acceptOptOutReading,
  optOutUserMessage,
  readIntentOnce,
  readReplyOnce,
} from './opt-out-reader';

describe('opt-out reader guards (structural, no model)', () => {
  it('drops a reading whose echo does not match the text', () => {
    expect(
      acceptOptOutReading(
        { intent: 'stop', verbatim: 'stop', language: 'fr', confirmation: 'ok' },
        'arrête',
      ),
    ).toBeNull();
  });

  it('keeps a stop with the model confirmation untouched, and the language the reader read', () => {
    const r = acceptOptOutReading(
      { intent: 'stop', verbatim: '别再发了', language: 'zh', confirmation: ' 好 ' },
      '别再发了',
    );
    expect(r).toEqual({ intent: 'stop', confirmation: '好', language: 'zh' });
  });

  it('none carries no confirmation', () => {
    expect(
      acceptOptOutReading(
        { intent: 'none', verbatim: 'hi', language: 'en', confirmation: 'x' },
        'hi',
      ),
    ).toEqual({ intent: 'none', confirmation: '', language: 'en' });
  });

  it('a crisis reading never carries the reader text: the reader only classifies', () => {
    for (const intent of ['crisis_mental', 'crisis_emergency'] as const) {
      expect(
        acceptOptOutReading(
          { intent, verbatim: 'x', language: 'fr', confirmation: 'Appelle le 988.' },
          'x',
        ),
      ).toEqual({ intent, confirmation: '', language: 'fr' });
    }
  });

  it('the language is a tag or null, never a sentence', () => {
    const read = (language: string) =>
      acceptOptOutReading({ intent: 'none', verbatim: 'x', language, confirmation: '' }, 'x')
        ?.language;
    expect(read(' AR ')).toBe('ar');
    expect(read('fr-ca')).toBe('fr-ca');
    expect(read('')).toBeNull();
    expect(read('the text is in French')).toBeNull();
  });

  it('sends the text, a language hint only when certain, and both lines when the region is unknown', () => {
    const message = JSON.parse(optOutUserMessage({ text: 'لا تراسلني', language: null }));
    expect(message.languageHint).toBeNull();
    expect(message.facts.region).toBeNull();
    expect(message.facts.canadaCrisisLine).toContain('9-8-8 Suicide Crisis Helpline');
    expect(message.facts.usCrisisLine).toContain('988 Suicide & Crisis Lifeline');
    expect(message.facts.emergency).toBe('911');
  });

  it('does not drop the US line because the parent wrote in French', () => {
    const message = JSON.parse(
      optOutUserMessage({ text: "je n'en peux plus, j'ai envie de mourir", language: 'fr' }),
    );
    expect(message.languageHint).toBe('fr');
    expect(message.facts.region).toBeNull();
    expect(message.facts.canadaCrisisLine).toContain('9-8-8 Suicide Crisis Helpline');
    expect(message.facts.usCrisisLine).toContain('988 Suicide & Crisis Lifeline');
    expect(message.facts.emergency).toBe('911');
  });

  it('passes the real line for the known region as facts', () => {
    const canada = JSON.parse(
      optOutUserMessage({ text: "je n'en peux plus", language: 'fr', region: 'CA' }),
    );
    expect(canada.languageHint).toBe('fr');
    expect(canada.facts.region).toBe('Canada');
    expect(canada.facts.crisisLine).toContain('9-8-8 Suicide Crisis Helpline');
    expect(canada.facts.emergency).toBe('911');

    const us = JSON.parse(
      optOutUserMessage({ text: 'i want to end it', language: 'en', region: 'US' }),
    );
    expect(us.facts.region).toBe('United States');
    expect(us.facts.crisisLine).toContain('988 Suicide & Crisis Lifeline');
    expect(us.facts.crisisLine).not.toContain('9-8-8 Suicide Crisis Helpline');
  });
});

/** A reader that answers in the language and region it was asked in, and counts its reads. */
function countingReader(intent: 'stop' | 'identity' | 'crisis_mental' = 'stop') {
  const calls: Array<{ language: string | null; region: string | null | undefined }> = [];
  const reader: OptOutReader = {
    read: async (input) => {
      calls.push({ language: input.language, region: input.region });
      return {
        intent,
        confirmation: `reply ${input.language}/${input.region === undefined ? 'unset' : input.region}`,
        language: input.language,
      };
    },
  };
  return { reader, calls };
}

describe('reply-bearing read: keyed on text, language and region, no fallback', () => {
  it('a CA read then a null-region read of the same text makes two reads', async () => {
    const { reader, calls } = countingReader('crisis_mental');
    const text = `ca then null ${Math.random()}`;
    await readReplyOnce(reader, { text, language: null, region: 'CA' });
    await readReplyOnce(reader, { text, language: null, region: null });
    expect(calls).toEqual([
      { language: null, region: 'CA' },
      { language: null, region: null },
    ]);
  });

  it('an explicit null region is its own key, distinct from a missing one', async () => {
    const { reader, calls } = countingReader();
    const text = `null vs unset ${Math.random()}`;
    await readReplyOnce(reader, { text, language: null, region: null });
    await readReplyOnce(reader, { text, language: null });
    expect(calls).toHaveLength(2);
  });

  it('the same text in two languages makes two reads, and a STOP confirmation never crosses languages', async () => {
    const { reader, calls } = countingReader('stop');
    const text = `two languages ${Math.random()}`;
    const fr = await readReplyOnce(reader, { text, language: 'fr' });
    const en = await readReplyOnce(reader, { text, language: 'en' });
    expect(calls).toHaveLength(2);
    expect(fr?.confirmation).toBe('reply fr/unset');
    expect(en?.confirmation).toBe('reply en/unset');
  });

  it('positive control: the same text, language and region share one read', async () => {
    const { reader, calls } = countingReader('stop');
    const text = `same key ${Math.random()}`;
    const first = await readReplyOnce(reader, { text, language: 'fr', region: 'CA' });
    const again = await readReplyOnce(
      { read: async () => ({ intent: 'none', confirmation: 'second', language: null }) },
      { text, language: 'fr', region: 'CA' },
    );
    expect(calls).toHaveLength(1);
    expect(again).toBe(first);
  });
});

describe('intent-only read: shared by text, carries no confirmation', () => {
  it('an intent-only read after a CA read makes one read and returns the intent alone', async () => {
    const { reader, calls } = countingReader('stop');
    const text = `intent after ca ${Math.random()}`;
    await readReplyOnce(reader, { text, language: 'fr', region: 'CA' });
    const intent = await readIntentOnce(reader, { text, language: null });
    expect(calls).toHaveLength(1);
    expect(intent).toEqual({ intent: 'stop' });
  });

  it('with no live read of the words, it reads once', async () => {
    const { reader, calls } = countingReader('identity');
    const text = `intent first ${Math.random()}`;
    expect(await readIntentOnce(reader, { text, language: 'en' })).toEqual({ intent: 'identity' });
    expect(await readIntentOnce(reader, { text, language: null })).toEqual({ intent: 'identity' });
    expect(calls).toHaveLength(1);
  });
});

describe('VIL-477 leave_group reading', () => {
  const text = 'Hale can you please leave this group chat';
  const value = {
    intent: 'leave_group' as const,
    verbatim: text,
    language: 'en',
    confirmation: 'ok, bye',
  };
  afterEach(() => vi.unstubAllEnvs());
  it('dark: stays the stop it always was', () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', '');
    expect(acceptOptOutReading(value, text)).toEqual({
      intent: 'stop',
      confirmation: 'ok, bye',
      language: 'en',
    });
  });
  it('lit: not a stop, no confirmation', () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', 'true');
    expect(acceptOptOutReading(value, text)).toEqual({
      intent: 'leave_group',
      confirmation: '',
      language: 'en',
    });
  });
});

describe('VIL-477 a temporary quiet ask is not a stop', () => {
  it('a none reading stays none with no confirmation, lit or dark', () => {
    const text = 'quiet-for-a-while ask';
    for (const lit of ['true', 'false']) {
      vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', lit);
      expect(
        acceptOptOutReading(
          { intent: 'none' as const, verbatim: text, language: 'en', confirmation: 'x' },
          text,
        ),
      ).toEqual({ intent: 'none', confirmation: '', language: 'en' });
    }
    vi.unstubAllEnvs();
  });
  it('the skill tells the reader a pause is none, not stop or leave_group', async () => {
    const { readFileSync } = await import('node:fs');
    const skill = readFileSync(
      new URL('../../../../../packages/agent/skills/opt-out-read.md', import.meta.url),
      'utf8',
    );
    expect(skill).toMatch(
      /quiet, hush or hold off for a while[\s\S]*is not `stop` and not\s+`leave_group`; it is `none`/,
    );
  });
});

describe('crisis reading direction', () => {
  it('the reader classifies a crisis and writes no crisis reply; it names the language it read', async () => {
    const { readFileSync } = await import('node:fs');
    const skill = readFileSync(
      new URL('../../../../../packages/agent/skills/opt-out-read.md', import.meta.url),
      'utf8',
    );
    expect(skill).toMatch(
      /`crisis_emergency` or `crisis_mental`, `confirmation` is an empty\s+string/,
    );
    expect(skill).toMatch(/`language`/);
    expect(skill).not.toMatch(/weave in that `crisisLine`/);
    // Positive control: the crisis readings themselves are still taught.
    expect(skill).toMatch(/- `crisis_emergency`: someone may be hurt/);
    expect(skill).toMatch(/- `crisis_mental`: the sender may be in a mental-health crisis/);
    const saidLine = readFileSync(
      new URL('../../../../../packages/agent/skills/said-line.md', import.meta.url),
      'utf8',
    );
    expect(saidLine).toMatch(/Stay with them/);
    expect(saidLine).not.toMatch(/glad they told you/);
  });
});
