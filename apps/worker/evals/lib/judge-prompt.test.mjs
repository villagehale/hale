import { describe, expect, it } from 'vitest';
import { judgePrompt, renderJudgePrompt } from './judge-prompt.mjs';

describe('renderJudgePrompt', () => {
  it('fills every {{variable}} with its value, numbers as their decimal text', () => {
    expect(
      renderJudgePrompt('t', 'Reason is at most {{reasonMaxChars}} characters. {{rule}}', {
        reasonMaxChars: 160,
        rule: 'Name every clash.',
      }),
    ).toBe('Reason is at most 160 characters. Name every clash.');
  });

  it('returns a prompt without variables byte for byte', () => {
    const text = 'Score 1-5.\n  Reply with ONLY the score tool.';
    expect(renderJudgePrompt('t', text)).toBe(text);
  });

  it('refuses a prompt variable the caller gave no value for', () => {
    expect(() => renderJudgePrompt('t', 'at most {{reasonMaxChars}}', {})).toThrow(
      /t: no value for \{\{reasonMaxChars\}\}/,
    );
  });

  it('refuses a value for a variable the prompt does not have', () => {
    expect(() => renderJudgePrompt('t', 'Score 1-5.', { rule: 'x' })).toThrow(
      /t: \{\{rule\}\} is not in the prompt/,
    );
  });

  it('does not re-read a filled value as a variable', () => {
    expect(renderJudgePrompt('t', 'A {{rule}} B', { rule: '{{other}}' })).toBe('A {{other}} B');
  });
});

describe('judgePrompt', () => {
  it('reads a managed judge prompt from apps/worker/prompts/judges', () => {
    expect(judgePrompt('crisis-reply')).toMatch(/^You grade one text message/);
  });

  it('throws for a judge prompt that does not exist', () => {
    expect(() => judgePrompt('no-such-judge')).toThrow(/ENOENT/);
  });
});
