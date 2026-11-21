import { afterEach, describe, expect, it, vi } from 'vitest';
import { namesKeyword, noStopKeywordCopyEnabled } from './no-stop-keyword';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('NO_STOP_KEYWORD_COPY_ENABLED', () => {
  it('is on only for the exact string true', () => {
    expect(noStopKeywordCopyEnabled({ NO_STOP_KEYWORD_COPY_ENABLED: 'true' })).toBe(true);
    vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', 'true');
    expect(noStopKeywordCopyEnabled()).toBe(true);
  });

  it.each(['', 'true\n', ' true', 'TRUE', 'True', 'on', '1', 'false'])(
    'stays off for %j',
    (value) => {
      expect(noStopKeywordCopyEnabled({ NO_STOP_KEYWORD_COPY_ENABLED: value })).toBe(false);
    },
  );

  it('stays off when unset', () => {
    expect(noStopKeywordCopyEnabled({})).toBe(false);
  });
});

describe('namesKeyword', () => {
  it.each([
    ['Reply STOP to opt out.', 'STOP'],
    ['replying STOP stops these messages', 'STOP'],
    ['Just reply stop anytime.', 'STOP'],
    ['You can text me "stop" whenever.', 'STOP'],
    ['Say \u201cstop\u201d and I will.', 'STOP'],
    ['You can opt out with the word help.', 'HELP'],
    ['Reply HELP for more.', 'HELP'],
    ['Reply START to come back.', 'START'],
    ['text start to come back', 'START'],
    ['Send UNSUBSCRIBE to leave.', 'UNSUBSCRIBE'],
    ['Répondez ARRÊT pour ne plus recevoir ces messages.', 'ARRET'],
    ['Dites simplement arrêt.', 'ARRET'],
    ['Répondez AIDE.', 'AIDE'],
    ['Reply \uFF33\uFF34\uFF2F\uFF30 anytime.', 'STOP'],
    ['Reply S\u200BTOP anytime.', 'STOP'],
  ])('refuses %j', (draft, keyword) => {
    expect(namesKeyword(draft)).toBe(keyword);
  });

  it.each([
    'You can tell me to stop anytime, in your own words.',
    'If you would rather I stop, just say so.',
    'Tell me if you want me to stop.',
    'Write to me whenever you want to start again.',
    'Start by telling me who you are.',
    "I can't help this group until one of the parents texts me directly.",
    'Dites-moi quand vous voulez que j’arrête, avec vos propres mots.',
  ])('leaves a plain sentence alone: %j', (draft) => {
    expect(namesKeyword(draft)).toBeNull();
  });

  it("does not count a fact's own word, and still counts an instruction that names it", () => {
    expect(namesKeyword('Thanks, HELP Daycare', ['HELP Daycare'])).toBeNull();
    expect(namesKeyword('Thanks, HELP Daycare')).toBe('HELP');
    expect(namesKeyword('Reply stop to Riley', ['stop'])).toBe('STOP');
  });
});
