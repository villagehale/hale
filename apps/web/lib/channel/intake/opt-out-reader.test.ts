import { describe, expect, it } from 'vitest';
import { acceptOptOutReading, optOutUserMessage } from './opt-out-reader';

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

  it('sends the text and thread language only', () => {
    expect(JSON.parse(optOutUserMessage({ text: 'لا تراسلني', language: null }))).toEqual({
      text: 'لا تراسلني',
      threadLanguage: null,
    });
  });
});
