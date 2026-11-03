import { createHash } from 'node:crypto';
import { strictToolSchema } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRISIS_SITUATIONS, CRISIS_WHO } from '~/lib/channel/crisis-resources';
import {
  OPT_OUT_READ_TOOL_SCHEMA,
  type OptOutReader,
  TEXT_READ_MAX_ENTRIES,
  acceptOptOutReading,
  optOutUserMessage,
  readIntentOnce,
  readReplyOnce,
  textReadCacheSnapshot,
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
          {
            intent,
            verbatim: 'x',
            language: 'fr',
            situation: 'unresponsive',
            confirmation: 'Appelle le 988.',
          },
          'x',
        ),
      ).toEqual({
        intent,
        confirmation: '',
        language: 'fr',
        situation: 'unresponsive',
        who: 'unknown',
      });
    }
  });

  it('the language is a tag or null, never a sentence', () => {
    const read = (language: string) =>
      acceptOptOutReading({ intent: 'none', verbatim: 'x', language, confirmation: '' }, 'x')
        ?.language;
    expect(read(' AR ')).toBe('ar');
    expect(read('')).toBeNull();
    expect(read('the text is in French')).toBeNull();
  });

  it('the language is one of a closed list of supported tags; anything else is null', () => {
    const read = (language: string) =>
      acceptOptOutReading({ intent: 'none', verbatim: 'x', language, confirmation: '' }, 'x')
        ?.language;
    for (const tag of ['en', 'fr', 'es', 'zh', 'zh-Hans', 'zh-Hant', 'ar', 'hi', 'pa']) {
      expect(read(tag)).toBe(tag);
    }
    expect(read(' ZH-HANT ')).toBe('zh-Hant');
    // A region on a supported language keeps the language and drops the subtag.
    expect(read('fr-ca')).toBe('fr');
    expect(read('en-call5550')).toBe('en');
    // An open subtag never reaches the writer, and an unlisted language is null.
    expect(read('xx')).toBeNull();
    expect(read('xx-callnow')).toBeNull();
  });

  it('keeps any language CLDR names, so a Korean or Haitian crisis reply is not written in English', () => {
    const read = (language: string) =>
      acceptOptOutReading({ intent: 'none', verbatim: 'x', language, confirmation: '' }, 'x')
        ?.language;
    expect(read('ko')).toBe('ko');
    expect(read('vi')).toBe('vi');
    expect(read('ht')).toBe('ht');
    expect(read('ko-kr')).toBe('ko');
    // Chinese keeps its script: a region names it when no script subtag does.
    expect(read('zh-hant-tw')).toBe('zh-Hant');
    expect(read('zh-tw')).toBe('zh-Hant');
    expect(read('zh-hk')).toBe('zh-Hant');
    expect(read('zh-cn')).toBe('zh-Hans');
    expect(read('pa-arab')).toBe('pa-Arab');
    // Not a language: no code, the special ISO 639 codes, an unnamed script subtag.
    expect(read('qq')).toBeNull();
    expect(read('zxx')).toBeNull();
    expect(read('mul')).toBeNull();
    expect(read('ko-qaaa')).toBe('ko');
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

describe('crisis situation: a closed enum, validated in code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const crisis = (situation: string | undefined) =>
    acceptOptOutReading(
      {
        intent: 'crisis_emergency',
        verbatim: 'x',
        language: 'en',
        confirmation: '',
        ...(situation === undefined ? {} : { situation }),
      },
      'x',
    );

  it('keeps every listed situation as read', () => {
    for (const situation of CRISIS_SITUATIONS) {
      expect(crisis(situation)?.situation).toBe(situation);
    }
  });

  it('an unknown value becomes other, named in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(crisis('call 555 0100 now')?.situation).toBe('other');
    expect(warn).toHaveBeenCalledWith(
      { reason: 'situation_unknown' },
      'opt-out reader: crisis situation not in the list - the writer gets other',
    );
  });

  it('none on a crisis reading is a contradiction, named as one; the writer gets other', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(crisis('none')?.situation).toBe('other');
    expect(warn).toHaveBeenCalledWith(
      { reason: 'situation_none_on_crisis' },
      'opt-out reader: crisis situation not in the list - the writer gets other',
    );
    expect(warn).not.toHaveBeenCalledWith({ reason: 'situation_unknown' }, expect.anything());
  });

  it('a missing value (a non-strict tool may skip it) becomes other, under its own name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(crisis(undefined)?.situation).toBe('other');
    expect(warn).toHaveBeenCalledWith(
      { reason: 'situation_missing' },
      'opt-out reader: crisis situation not in the list - the writer gets other',
    );
  });

  it('a reading that is not a crisis carries no situation, whatever the model wrote', () => {
    const r = acceptOptOutReading(
      { intent: 'none', verbatim: 'x', language: 'en', situation: 'fire', confirmation: '' },
      'x',
    );
    expect(r).toEqual({ intent: 'none', confirmation: '', language: 'en' });
  });

  it('the tool schema asks for it as a required closed enum, and still compiles to the strict grammar', () => {
    const { properties, required } = OPT_OUT_READ_TOOL_SCHEMA;
    expect(properties.situation).toEqual({ type: 'string', enum: [...CRISIS_SITUATIONS, 'none'] });
    expect(required).toContain('situation');
    const grammar = strictToolSchema(
      OPT_OUT_READ_TOOL_SCHEMA as unknown as Parameters<typeof strictToolSchema>[0],
    ) as { properties: Record<string, unknown>; required: string[] } | null;
    expect(grammar).not.toBeNull();
    expect(grammar?.properties.situation).toEqual(properties.situation);
    expect(grammar?.required).toContain('situation');
  });

  it('the skill teaches every situation by name', async () => {
    const { readFileSync } = await import('node:fs');
    const skill = readFileSync(
      new URL('../../../../../packages/agent/skills/opt-out-read.md', import.meta.url),
      'utf8',
    );
    for (const situation of [...CRISIS_SITUATIONS, 'none']) {
      expect(skill).toContain(`\`${situation}\``);
    }
  });
});

describe('who is in danger: a closed enum, validated in code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const crisis = (who: string | undefined) =>
    acceptOptOutReading(
      {
        intent: 'crisis_emergency',
        verbatim: 'x',
        language: 'en',
        situation: 'unresponsive',
        confirmation: '',
        ...(who === undefined ? {} : { who }),
      },
      'x',
    );

  it('keeps every listed value as read', () => {
    for (const who of ['child', 'adult', 'self', 'unknown']) {
      expect(crisis(who)?.who).toBe(who);
    }
    expect([...CRISIS_WHO]).toEqual(['child', 'adult', 'self', 'unknown']);
  });

  it('a value not in the list becomes unknown, named in the log, and never reaches the writer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(crisis('my son, call 555 0100')?.who).toBe('unknown');
    expect(warn).toHaveBeenCalledWith(
      { reason: 'who_unknown' },
      'opt-out reader: who is in danger not in the list - the writer gets unknown',
    );
  });

  it('a missing value becomes unknown, under its own name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(crisis(undefined)?.who).toBe('unknown');
    expect(warn).toHaveBeenCalledWith(
      { reason: 'who_missing' },
      'opt-out reader: who is in danger not in the list - the writer gets unknown',
    );
  });

  it('a reading that is not a crisis carries no who, whatever the model wrote', () => {
    const r = acceptOptOutReading(
      { intent: 'stop', verbatim: 'x', language: 'en', who: 'child', confirmation: 'ok' },
      'x',
    );
    expect(r).toEqual({ intent: 'stop', confirmation: 'ok', language: 'en' });
  });

  it('the tool schema asks for it as a required closed enum, and still compiles to the strict grammar', () => {
    const { properties, required } = OPT_OUT_READ_TOOL_SCHEMA;
    expect(properties.who).toEqual({ type: 'string', enum: ['child', 'adult', 'self', 'unknown'] });
    expect(required).toContain('who');
    const grammar = strictToolSchema(
      OPT_OUT_READ_TOOL_SCHEMA as unknown as Parameters<typeof strictToolSchema>[0],
    ) as { properties: Record<string, unknown>; required: string[] } | null;
    expect(grammar?.properties.who).toEqual(properties.who);
    expect(grammar?.required).toContain('who');
  });

  it('the skill teaches every value by name', async () => {
    const { readFileSync } = await import('node:fs');
    const skill = readFileSync(
      new URL('../../../../../packages/agent/skills/opt-out-read.md', import.meta.url),
      'utf8',
    );
    expect(skill).toContain('`who`');
    for (const who of CRISIS_WHO) {
      expect(skill).toContain(`\`${who}\``);
    }
  });
});

describe('stop/start confirmation: no number, no link (written from raw parent text)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a confirmation with a URL is not kept; the stop still stands, and the withholding is named', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = acceptOptOutReading(
      {
        intent: 'stop',
        verbatim: 'stop',
        language: 'en',
        confirmation: 'Done. Come back at https://example.org/start',
      },
      'stop',
    );
    expect(r).toEqual({ intent: 'stop', confirmation: '', language: 'en' });
    expect(error).toHaveBeenCalledWith(
      { intent: 'stop', reason: 'link' },
      'opt-out reader: confirmation carried a number or link - not sent',
    );
  });

  it('a start confirmation with a number is not kept; the start still stands', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = acceptOptOutReading(
      { intent: 'start', verbatim: 'start', language: 'en', confirmation: 'Back! Call 555 0100' },
      'start',
    );
    expect(r).toEqual({ intent: 'start', confirmation: '', language: 'en' });
    expect(error).toHaveBeenCalledWith(
      { intent: 'start', reason: 'other_number' },
      'opt-out reader: confirmation carried a number or link - not sent',
    );
  });

  it('positive control: a plain confirmation is kept and nothing is logged', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = acceptOptOutReading(
      {
        intent: 'stop',
        verbatim: 'stop',
        language: 'en',
        confirmation: 'Got it, no more texts. Text START to come back.',
      },
      'stop',
    );
    expect(r?.confirmation).toBe('Got it, no more texts. Text START to come back.');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('text-read cache is bounded', () => {
  it('past the bound the oldest read is evicted, and the newest still answers from cache', async () => {
    const { reader, calls } = countingReader('stop');
    const run = Math.random();
    for (let i = 0; i <= TEXT_READ_MAX_ENTRIES; i += 1) {
      await readReplyOnce(reader, { text: `bound ${run} ${i}`, language: null });
    }
    expect(calls).toHaveLength(TEXT_READ_MAX_ENTRIES + 1);
    await readReplyOnce(reader, { text: `bound ${run} ${TEXT_READ_MAX_ENTRIES}`, language: null });
    expect(calls).toHaveLength(TEXT_READ_MAX_ENTRIES + 1);
    await readReplyOnce(reader, { text: `bound ${run} 0`, language: null });
    expect(calls).toHaveLength(TEXT_READ_MAX_ENTRIES + 2);
  });
});

describe('text-read cache holds no parent text', () => {
  it('keys on a sha256 of the text, language and region; the raw words are in no key or entry', async () => {
    const { reader, calls } = countingReader('crisis_mental');
    const words = `cachedwordsprobe${Math.random().toString(36).slice(2)}`;
    await readReplyOnce(reader, { text: words, language: 'fr', region: 'CA' });
    await readReplyOnce(reader, { text: words, language: 'en', region: 'CA' });
    const snapshot = textReadCacheSnapshot();
    expect(calls).toHaveLength(2);
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const textKey = sha(words);
    // Positive control: both reads are in the cache, so the absence below is not an empty cache.
    const mine = snapshot.filter((entry) => entry.textKey === textKey);
    expect(mine).toHaveLength(2);
    for (const entry of snapshot) {
      expect(entry.key).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.textKey).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(mine.map((entry) => entry.key)).size).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain('cachedwordsprobe');
    // The intent-only read still finds the live read of the same words: no third read.
    expect(await readIntentOnce(reader, { text: words, language: null })).toEqual({
      intent: 'crisis_mental',
    });
    expect(calls).toHaveLength(2);
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
  it('dark: a confirmation carrying a link is not sent, and the stop still runs', () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      acceptOptOutReading({ ...value, confirmation: 'ok, bye. Back at https://example.org' }, text),
    ).toEqual({ intent: 'stop', confirmation: '', language: 'en' });
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
