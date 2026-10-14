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

  it('fills link slots with the exact URL and refuses any URL the model typed', () => {
    const url = 'https://hale.example/connect?t=a';
    const links: SaidLineInput = {
      purpose: 'connector_link',
      language: null,
      facts: { link: '[[link]]', minutesValid: 15 },
      links: { link: url },
    };
    expect(acceptSaidLine('Tap to connect:\n[[link]]\nGood for 15 minutes.', links)).toBe(
      `Tap to connect:\n${url}\nGood for 15 minutes.`,
    );
    // Retyped (even correctly), missing, doubled, or an unknown slot: refused.
    expect(acceptSaidLine(`Tap: ${url}`, links)).toBeNull();
    expect(acceptSaidLine('Tap to connect.', links)).toBeNull();
    expect(acceptSaidLine('[[link]] and [[link]]', links)).toBeNull();
    expect(acceptSaidLine('[[link]] [[other]]', links)).toBeNull();
  });
});
