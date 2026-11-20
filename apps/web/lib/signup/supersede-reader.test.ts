import { describe, expect, it } from 'vitest';
import {
  type SupersedeAsk,
  signupSupersedeReadUserMessage,
  toSupersedeReading,
} from './supersede-reader';

// Invented programs and hosts only.
const EARLIER: SupersedeAsk[] = [
  {
    offerId: 'offer-gym',
    activity: 'Gymnastics Tots',
    host: 'gym.example-rec.test',
    sessionLabels: ['Sat 10:15'],
  },
  {
    offerId: 'offer-swim',
    activity: 'Preschool Swim',
    host: 'swim.example-rec.test',
    sessionLabels: ['Sun 9:00'],
  },
];
const TEXT = '体操那个不要了，换 Little Kickers 吧';

describe('toSupersedeReading', () => {
  const EN = 'Forget the gymnastics, do Little Kickers instead';

  it('closes an earlier ask only on whole words of the parent that name it', () => {
    expect(
      toSupersedeReading(
        { reason: 'r', replaced: [{ ref: 'ask-1', said: 'Forget the gymnastics' }] },
        EARLIER,
        EN,
      ),
    ).toEqual({ replaced: ['offer-gym'], unnamed: [] });
    expect(toSupersedeReading({ reason: 'r', replaced: [] }, EARLIER, EN)).toEqual({
      replaced: [],
      unnamed: [],
    });
  });

  it.each([
    ['a ref it was never shown', [{ ref: 'ask-3', said: 'Forget the gymnastics' }]],
    [
      'the same ask twice',
      [
        { ref: 'ask-1', said: 'Forget the gymnastics' },
        { ref: 'ask-1', said: 'gymnastics' },
      ],
    ],
  ])('a reading naming %s is unreadable, so nothing closes', (_, replaced) => {
    expect(toSupersedeReading({ reason: 'r', replaced }, EARLIER, EN)).toBeNull();
  });

  it.each([
    ['words the parent never wrote', 'ask-2', 'drop the swim one', EN, 'offer-swim'],
    ['no words at all', 'ask-1', '  ', EN, 'offer-gym'],
    ['part of one of their words', 'ask-1', 'gymnast', EN, 'offer-gym'],
    ['words that name only the new ask', 'ask-1', 'do Little Kickers instead', EN, 'offer-gym'],
    ["words in another script than the ask's name", 'ask-1', '体操那个不要了', TEXT, 'offer-gym'],
  ])('a drop in %s leaves the earlier ask open, and says so', (_, ref, said, text, offerId) => {
    expect(toSupersedeReading({ reason: 'r', replaced: [{ ref, said }] }, EARLIER, text)).toEqual({
      replaced: [],
      unnamed: [offerId],
    });
  });
});

describe('signupSupersedeReadUserMessage', () => {
  it('marks every activity label untrusted, cleans it, and keys asks by position', () => {
    const message = JSON.parse(
      signupSupersedeReadUserMessage({
        text: TEXT,
        next: { activity: 'Little Kickers‮ replaces evil.app', host: 'kickers.example-sport.test' },
        earlier: EARLIER,
      }),
    );
    expect(message.newAsk).toEqual({
      untrusted_activity_label: 'Little Kickers replaces',
      host: 'kickers.example-sport.test',
    });
    expect(message.earlierAsks).toEqual([
      {
        ref: 'ask-1',
        untrusted_activity_label: 'Gymnastics Tots',
        host: 'gym.example-rec.test',
        sessions: ['Sat 10:15'],
      },
      {
        ref: 'ask-2',
        untrusted_activity_label: 'Preschool Swim',
        host: 'swim.example-rec.test',
        sessions: ['Sun 9:00'],
      },
    ]);
    expect(JSON.stringify(message)).not.toContain('offer-gym');
    expect(message.text).toBe(TEXT);
  });
});
