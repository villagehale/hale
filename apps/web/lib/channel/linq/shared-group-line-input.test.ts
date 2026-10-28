import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sharedGroupLineInput } from './shared-group-line-input';
import { sharedLineUsable } from './shared-group-voice';

describe('shared group line input', () => {
  it('gives the intro one question and the stop no question', () => {
    const intro = sharedGroupLineInput({ kind: 'intro', adderFirstName: 'Mei' }, 'en');
    expect(intro.questions).toBe(1);
    expect(intro.maxChars).toBe(240);
    expect(intro.facts.adderFirstName).toBe('Mei');
    const stop = sharedGroupLineInput({ kind: 'member_stop', name: 'Jordan' }, 'en');
    expect(stop.questions).toBe(0);
    expect(stop.wayOut).toBe(true);
  });

  it('refuses a private token, a URL, and a second question', () => {
    const answer = sharedGroupLineInput({ kind: 'answer', lookup: null }, 'en');
    expect(sharedLineUsable('Saturday at the pool the thread already named.', answer)).toBe(true);
    expect(sharedLineUsable('Zephyrina has soccer', answer, ['Zephyrina'])).toBe(false);
    expect(sharedLineUsable('See https://example.com', answer)).toBe(false);
    expect(sharedLineUsable('Are you in? What time?', answer)).toBe(false);
    expect(sharedLineUsable('TODO-Design: placeholder', answer)).toBe(false);
  });

  it('keeps parent-facing directions in the skill, not in TypeScript strings', () => {
    const skill = readFileSync(
      new URL('../../../../../packages/agent/skills/shared-group-voice.md', import.meta.url),
      'utf8',
    );
    const source = readFileSync(new URL('./shared-group-line-input.ts', import.meta.url), 'utf8');
    expect(skill).not.toContain('TODO-Design');
    expect(source).not.toContain('TODO-Design');
    expect(source).not.toMatch(/our family is in this group/i);
  });
});
