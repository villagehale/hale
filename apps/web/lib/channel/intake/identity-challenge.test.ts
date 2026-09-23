import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { IDENTITY_ACCOUNTABILITY_LINE, IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE } from './copy';
import { identityChallengeReply, isIdentityChallenge } from './identity-challenge';

const LOCKED_EN =
  'This is Hale from Village Hale Technologies Inc. (villagehale.com). Barton Dong runs it (aloha@villagehale.com). Reply STOP anytime and we stop.';
const LOCKED_FR =
  "C'est Hale, Village Hale Technologies Inc. (villagehale.com). Barton Dong en est responsable (aloha@villagehale.com). Reponds STOP et on arrete.";

describe('identity challenge · locked bytes', () => {
  it('pins the English disclosure exactly', () => {
    expect(IDENTITY_ACCOUNTABILITY_LINE).toBe(LOCKED_EN);
    expect(IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.en).toBe(LOCKED_EN);
    expect(smsEncoding(LOCKED_EN)).toBe('gsm7');
    expect(smsSegments(LOCKED_EN)).toBe(1);
    expect(LOCKED_EN).not.toContain('?');
  });

  it('pins the French GSM-7 twin exactly', () => {
    expect(IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE.fr).toBe(LOCKED_FR);
    expect(smsEncoding(LOCKED_FR)).toBe('gsm7');
    expect(smsSegments(LOCKED_FR)).toBe(1);
    expect(LOCKED_FR).not.toMatch(/[àâäéèêëïîôùûüçœ]/i);
    expect(LOCKED_FR).not.toContain('?');
  });
});

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

describe('identityChallengeReply', () => {
  it('sends the locked English line, and the French twin when the inbound is French', () => {
    expect(identityChallengeReply("I'm a Police Officer give your name and address please")).toBe(
      LOCKED_EN,
    );
    expect(identityChallengeReply('Qui etes-vous?')).toBe(LOCKED_FR);
    expect(identityChallengeReply('When does swim registration open?')).toBeNull();
  });
});
