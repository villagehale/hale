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
  it('maps each replaced ref to its offer when the parent wrote the words that drop it', () => {
    expect(
      toSupersedeReading(
        { reason: 'r', replaced: [{ ref: 'ask-1', said: '体操那个不要了' }] },
        EARLIER,
        TEXT,
      ),
    ).toEqual(['offer-gym']);
    expect(toSupersedeReading({ reason: 'r', replaced: [] }, EARLIER, TEXT)).toEqual([]);
  });

  it.each([
    ['a ref it was never shown', [{ ref: 'ask-3', said: '体操那个不要了' }]],
    [
      'the same ask twice',
      [
        { ref: 'ask-1', said: '体操那个不要了' },
        { ref: 'ask-1', said: '不要了' },
      ],
    ],
    ['words the parent never wrote', [{ ref: 'ask-2', said: 'drop the swim one' }]],
    ['no words at all', [{ ref: 'ask-1', said: '  ' }]],
  ])('a reading naming %s is unreadable, so nothing closes', (_, replaced) => {
    expect(toSupersedeReading({ reason: 'r', replaced }, EARLIER, TEXT)).toBeNull();
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
