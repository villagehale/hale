import { describe, expect, it } from 'vitest';
import { VOICE_GOODBYE_BY_LANGUAGE } from './copy';
import { spokenFarewell } from './voice-goodbye';

/**
 * The founder's own call ended three times and never hung up (2026-08-2x, CA170c1fb0):
 * "And that's all for today.", "Yeah. It's ciao. Bye bye.", "You can you can hang up
 * now." — three goodbyes, three answers, a live line, and in the end the parent hung up
 * on Hale.
 *
 * What this table is really protecting is the OTHER direction. A detector that hangs up
 * on a sentence containing a farewell word would drop calls mid-question, which is a
 * worse failure than the one it fixes: the parent has to ring back and start again.
 */
describe('spokenFarewell', () => {
  it.each([
    ["And that's all for today.", VOICE_GOODBYE_BY_LANGUAGE.en],
    ["Yeah. It's ciao. Bye bye.", VOICE_GOODBYE_BY_LANGUAGE.en],
    ['You can you can hang up now.', VOICE_GOODBYE_BY_LANGUAGE.en],
    ['bye', VOICE_GOODBYE_BY_LANGUAGE.en],
    ['ok thanks bye', VOICE_GOODBYE_BY_LANGUAGE.en],
    ["alright I'm done", VOICE_GOODBYE_BY_LANGUAGE.en],
    ['au revoir', VOICE_GOODBYE_BY_LANGUAGE.fr],
    ["merci, c'est tout", VOICE_GOODBYE_BY_LANGUAGE.fr],
    ['tu peux raccrocher', VOICE_GOODBYE_BY_LANGUAGE.fr],
  ])('hears %j as the end of the call', (utterance, expected) => {
    expect(spokenFarewell(utterance)).toBe(expected);
  });

  it.each([
    // The whole reason this is not a substring match.
    'I need to buy new shoes for daycare',
    'bye the way can you check swim',
    "that's all I need to know about swim on Thursday",
    'ok bye can you first tell me when gym is',
    // A thank-you is a settled turn, not a hang-up — the skill answers it in one clause.
    'thanks',
    'thank you so much',
    // The parent is describing a hang-up, not asking for one.
    'the daycare hung up on me this morning',
    '',
  ])('does NOT hang up on %j', (utterance) => {
    expect(spokenFarewell(utterance)).toBeNull();
  });
});
