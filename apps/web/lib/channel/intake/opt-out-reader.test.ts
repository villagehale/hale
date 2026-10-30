import { describe, expect, it } from 'vitest';
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

  it('sends the text and a language hint only when certain', () => {
    expect(JSON.parse(optOutUserMessage({ text: 'لا تراسلني', language: null }))).toEqual({
      text: 'لا تراسلني',
      languageHint: null,
    });
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
});

describe('VIL-477 leave_group reading', () => {
  const text = 'Hale can you please leave this group chat';
  const value = { intent: 'leave_group' as const, verbatim: text, confirmation: 'ok, bye' };
  it('dark: stays the stop it always was', () => {
    const prev = process.env.LINQ_GROUP_LEAVE_ENABLED;
    delete process.env.LINQ_GROUP_LEAVE_ENABLED;
    expect(acceptOptOutReading(value, text)).toEqual({ intent: 'stop', confirmation: 'ok, bye' });
    if (prev !== undefined) process.env.LINQ_GROUP_LEAVE_ENABLED = prev;
  });
  it('lit: not a stop, no confirmation', () => {
    const prev = process.env.LINQ_GROUP_LEAVE_ENABLED;
    process.env.LINQ_GROUP_LEAVE_ENABLED = 'true';
    expect(acceptOptOutReading(value, text)).toEqual({ intent: 'leave_group', confirmation: '' });
    if (prev === undefined) delete process.env.LINQ_GROUP_LEAVE_ENABLED;
    else process.env.LINQ_GROUP_LEAVE_ENABLED = prev;
  });
});
