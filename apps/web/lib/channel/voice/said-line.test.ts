import { describe, expect, it } from 'vitest';
import { type SaidLineInput, acceptSaidLine } from './said-line';

const health: SaidLineInput = {
  purpose: 'health',
  language: 'en',
  parentWords: 'my son fell and his wrist is swollen',
  facts: { healthLine: 'Health811 (Ontario), call 811, any time', emergency: '911' },
  mustInclude: ['811', '911'],
};

describe('said-line · code checks the facts, the model writes the words', () => {
  it('accepts any wording that carries both numbers', () => {
    const text =
      'I can’t advise on that. Health811 is there any time at 811, and for an emergency call 911.';
    expect(acceptSaidLine(text, health)).toBe(text);
  });

  it('refuses a health line missing a number', () => {
    expect(acceptSaidLine('Call 811 any time.', health)).toBeNull();
  });

  it('refuses an empty write', () => {
    expect(acceptSaidLine('   ', health)).toBeNull();
  });

  it('refuses a link that was not a required fact', () => {
    const links: SaidLineInput = {
      purpose: 'connector_links',
      language: 'en',
      facts: { minutes: 15 },
      mustInclude: ['https://hale.example/connect?t=a'],
    };
    expect(
      acceptSaidLine('Calendar: https://hale.example/connect?t=a and https://evil.example', links),
    ).toBeNull();
    expect(acceptSaidLine('Calendar: https://hale.example/connect?t=a', links)).not.toBeNull();
  });
});
