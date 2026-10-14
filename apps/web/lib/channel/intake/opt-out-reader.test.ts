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
