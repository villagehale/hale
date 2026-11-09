import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACK_ONLY,
  SAID_LINE_CONVEY_FIXTURES,
  conveyFacts,
  conveyUserMessage,
} from './said-line-convey-fixtures.mjs';
import { INTRO_REPLY_FACTS } from './said-line-fixtures.mjs';

const FACT = INTRO_REPLY_FACTS.discoverability_off.pendingClosed;

describe('said-line convey fixtures (VIL-530)', () => {
  it('judges pendingClosed on intro off, and both outcomes are in the corpus', () => {
    expect(conveyFacts()).toEqual([{ key: 'pendingClosed', meaning: FACT }]);
    const expects = SAID_LINE_CONVEY_FIXTURES.map((fixture) => fixture.expect);
    expect(expects).toContain('send');
    expect(expects).toContain('omit');
    expect(new Set(SAID_LINE_CONVEY_FIXTURES.map((fixture) => fixture.id)).size).toBe(
      SAID_LINE_CONVEY_FIXTURES.length,
    );
  });

  it('includes the acknowledgement the structural check still accepts', () => {
    const omitted = SAID_LINE_CONVEY_FIXTURES.find(
      (fixture) => fixture.id === 'intro-off-ja-omits',
    );
    expect(omitted).toMatchObject({ draft: ACK_ONLY, expect: 'omit' });
  });

  it('has a send draft that is not the English fact, and an omit draft a word list would keep', () => {
    const sends = SAID_LINE_CONVEY_FIXTURES.filter((fixture) => fixture.expect === 'send');
    expect(sends.some((fixture) => !fixture.draft.includes(FACT))).toBe(true);
    const unrelated = SAID_LINE_CONVEY_FIXTURES.find(
      (fixture) => fixture.id === 'intro-off-en-unrelated-closed',
    );
    expect(unrelated?.expect).toBe('omit');
    expect(unrelated?.draft.toLowerCase().includes('closed')).toBe(true);
    expect(unrelated?.draft.includes(FACT)).toBe(false);
  });

  it('grades those expects with the cached real judge, not a scripted verdict', () => {
    const runner = readFileSync(
      new URL('./run-said-line-convey-eval.mjs', import.meta.url),
      'utf8',
    );
    expect(runner).toContain('cachedToolCall');
    expect(runner).toContain('grade(judged.value?.conveyed, expected)');
    expect(runner).not.toContain('scriptedClient');
    expect(runner).not.toMatch(/conveyed:\s*'yes'/);
  });

  it('puts the fact meaning in the judge payload, not a phrase to find in the draft', () => {
    const message = JSON.parse(conveyUserMessage('わかりました。'));
    expect(message).toEqual({
      draft: 'わかりました。',
      mustConvey: [{ key: 'pendingClosed', meaning: FACT }],
    });
  });
});
