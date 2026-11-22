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
    ['You can reply anytime with stop.', 'STOP'],
    ['Reply at any time with stop.', 'STOP'],
    ['Just reply whenever with stop.', 'STOP'],
    ['Text me right now with stop.', 'STOP'],
    ['Reply again with start.', 'START'],
    ['Répondez à tout moment avec arrêt.', 'ARRET'],
    ["Répondez n'importe quand avec arrêt.", 'ARRET'],
    ['Just send a quick stop.', 'STOP'],
    ['Reply with a simple stop.', 'STOP'],
    ['Reply in this thread with stop.', 'STOP'],
    ['Envoyez un petit arrêt.', 'ARRET'],
    ['You can text "stop."', 'STOP'],
    ['You can always tell me \u201cstop.\u201d', 'STOP'],
    ['Just say "stop!"', 'STOP'],
    ['If you are done, "stop," is enough.', 'STOP'],
    ['Un simple \u00ab arr\u00eat. \u00bb suffit.', 'ARRET'],
    ['Un simple \u00ab stop ! \u00bb suffit.', 'STOP'],
    ['Just "stop\u2026" works.', 'STOP'],
    ['Tell me stop.', 'STOP'],
    ['Just tell me stop anytime.', 'STOP'],
    ['You can tell us stop whenever.', 'STOP'],
    ['Tell Hale stop.', 'STOP'],
    ['Tell me start when you want back in.', 'START'],
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
    'You can text me anytime and I will stop.',
    'Text me anytime if you want me to stop.',
    'Reply anytime to stop.',
    'Text me anytime for help.',
    'Just say you want help.',
    'Écrivez-moi à tout moment si vous voulez que j’arrête.',
    'You can tell me anytime, in your own words, that you would like me to stop.',
    'Hale is an AI, and I stop whenever you ask, in any words.',
    'Just say so and I will stop texting you.',
    'Tu peux me dire d’arrêter quand tu veux.',
    'Tell me to stop anytime.',
    'Tell me the start date.',
    'Tell me when to start.',
    'Tell me if you need help.',
    'Tell me any help you need.',
    'Tell me at the start.',
    'She said "stop by anytime" and we did.',
  ])('leaves a plain sentence alone: %j', (draft) => {
    expect(namesKeyword(draft)).toBeNull();
  });

  it("does not count a fact's own word, and still counts an instruction that names it", () => {
    expect(namesKeyword('Thanks, HELP Daycare', ['HELP Daycare'])).toBeNull();
    expect(namesKeyword('Thanks, HELP Daycare')).toBe('HELP');
    expect(namesKeyword('Reply stop to Riley', ['stop'])).toBe('STOP');
  });
});
