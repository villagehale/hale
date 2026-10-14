import { describe, expect, it } from 'vitest';
import { isIdentityChallenge } from './identity-challenge';

describe('isIdentityChallenge', () => {
  it('catches the live police-officer demand and the other distrust shapes', () => {
    const challenges = [
      "I'm a Police Officer give your name and address please",
      'who are you?',
      "who's this",
      'who is this exactly?',
      'who is behind this number',
      'wait is this a real person or a bot',
      'is this a scam',
      'are you legit',
      "I don't trust this",
      'give your name and address',
      "what's your business address",
      'identify yourself',
      'Qui etes-vous?',
      "C'est qui?",
      'je suis policier, donnez votre adresse',
      "c'est une arnaque",
      "I'm a police officer",
    ];
    for (const body of challenges) {
      expect(isIdentityChallenge(body), body).toBe(true);
    }
  });

  it('leaves ordinary parent questions alone', () => {
    const ordinary = [
      'hi',
      'Maya is 4, Theo is 1, M5V 2T6',
      'When does swim registration open near me?',
      "What's the address for the Markham pool?",
      "Who is Maya's teacher?",
      'who is the prime minister',
      'who won the world cup',
      'can you give me the camp address',
      "what's her name",
      'who is this for',
      'Does Sebastian need an eye exam?',
      "I'm a teacher and Noah is 4, L3R",
      "I'm a lawyer and Maya is 4, please watch swim registration",
      'my lawyer said we should register early',
      'the police station is near the library',
      'thanks',
      'cheer me up',
      'How do I get him to nap?',
      "I don't trust this daycare, find another",
      'is the city registration a scam',
    ];
    for (const body of ordinary) {
      expect(isIdentityChallenge(body), body).toBe(false);
    }
  });
});
