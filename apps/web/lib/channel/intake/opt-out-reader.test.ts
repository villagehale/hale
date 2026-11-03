import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type OptOutReader,
  acceptOptOutReading,
  optOutUserMessage,
  readTextOnce,
} from './opt-out-reader';

describe('opt-out reader guards (structural, no model)', () => {
  it('drops a reading whose echo does not match the text', () => {
    expect(
      acceptOptOutReading({ intent: 'stop', verbatim: 'stop', confirmation: 'ok' }, 'arrête'),
    ).toBeNull();
  });

  it('keeps a stop with the model confirmation untouched', () => {
    const r = acceptOptOutReading(
      { intent: 'stop', verbatim: '别再发了', confirmation: ' 好 ' },
      '别再发了',
    );
    expect(r).toEqual({ intent: 'stop', confirmation: '好' });
  });

  it('none carries no confirmation', () => {
    expect(
      acceptOptOutReading({ intent: 'none', verbatim: 'hi', confirmation: 'x' }, 'hi'),
    ).toEqual({ intent: 'none', confirmation: '' });
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

  it('passes the real line for the known region as facts to weave in', () => {
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

  it('reads one text once, even when the router and intake hold different readers', async () => {
    const calls: string[] = [];
    const reader = (): OptOutReader => ({
      read: async (input) => {
        calls.push(input.text);
        return { intent: 'none', confirmation: '' };
      },
    });
    const text = `single-read ${Math.random()}`;
    await readTextOnce(reader(), { text, language: 'en' });
    await readTextOnce(reader(), { text, language: null });
    expect(calls).toEqual([text]);
  });

  it('two families in different regions sending the same words each get their own reading', async () => {
    const reader: OptOutReader = {
      read: async (input) => ({
        intent: 'crisis_mental',
        confirmation: `reading for ${input.region}`,
      }),
    };
    const text = `same words ${Math.random()}`;
    const canada = await readTextOnce(reader, { text, language: null, region: 'CA' });
    const us = await readTextOnce(reader, { text, language: null, region: 'US' });
    expect(canada?.confirmation).toBe('reading for CA');
    expect(us?.confirmation).toBe('reading for US');
    // Positive control: the same region still shares one read.
    const canadaAgain = await readTextOnce(
      { read: async () => ({ intent: 'none', confirmation: 'second read' }) },
      { text, language: null, region: 'CA' },
    );
    expect(canadaAgain?.confirmation).toBe('reading for CA');
  });
});

describe('VIL-477 leave_group reading', () => {
  const text = 'Hale can you please leave this group chat';
  const value = { intent: 'leave_group' as const, verbatim: text, confirmation: 'ok, bye' };
  afterEach(() => vi.unstubAllEnvs());
  it('dark: stays the stop it always was', () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', '');
    expect(acceptOptOutReading(value, text)).toEqual({ intent: 'stop', confirmation: 'ok, bye' });
  });
  it('lit: not a stop, no confirmation', () => {
    vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', 'true');
    expect(acceptOptOutReading(value, text)).toEqual({ intent: 'leave_group', confirmation: '' });
  });
});

describe('VIL-477 a temporary quiet ask is not a stop', () => {
  it('a none reading stays none with no confirmation, lit or dark', () => {
    const text = 'quiet-for-a-while ask';
    for (const lit of ['true', 'false']) {
      vi.stubEnv('LINQ_GROUP_LEAVE_ENABLED', lit);
      expect(
        acceptOptOutReading({ intent: 'none' as const, verbatim: text, confirmation: 'x' }, text),
      ).toEqual({ intent: 'none', confirmation: '' });
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

describe('crisis reply direction', () => {
  it('tells the model to stay with them and weave the facts, and to send nothing if it cannot write', async () => {
    const { readFileSync } = await import('node:fs');
    const skill = readFileSync(
      new URL('../../../../../packages/agent/skills/opt-out-read.md', import.meta.url),
      'utf8',
    );
    expect(skill).toMatch(/Stay with them/);
    expect(skill).toMatch(/nothing is sent/);
    expect(skill).toMatch(/Do not infer a country\s+from the language/);
    expect(skill).toMatch(/The whole reply is in the sender's own/);
    expect(skill).toMatch(/Do not add a 988 line/);
    expect(skill).toMatch(/both\s+lines were given/);
    expect(skill).not.toMatch(/no closing question/);
    expect(skill).toMatch(/Name no digits you were not given/);
    expect(skill).not.toMatch(/glad they told you/);
    expect(skill).not.toMatch(/3114/);
    const saidLine = readFileSync(
      new URL('../../../../../packages/agent/skills/said-line.md', import.meta.url),
      'utf8',
    );
    expect(saidLine).toMatch(/Stay with them/);
    expect(saidLine).not.toMatch(/glad they told you/);
  });
});
