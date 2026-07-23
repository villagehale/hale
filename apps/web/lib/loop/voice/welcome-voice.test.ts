import { describe, expect, it } from 'vitest';
import type { WelcomeContent } from '~/lib/onboarding/welcome-email';
import {
  parseWelcomeVoiceAnswer,
  welcomeVoiceContext,
  welcomeVoiceFactSlots,
} from './welcome-voice';

/**
 * The pure welcome-voice parse/validate + slot seam (VIL-229). We prove the STRICT
 * contract and — rule #1 — that the model is handed only the coarse intake (never a
 * child name or DOB).
 */

const content = (over: Partial<WelcomeContent> = {}): WelcomeContent => ({
  firstName: 'Barton',
  place: 'your neighbourhood',
  stage: 'the toddler years',
  voice: null,
  ...over,
});

describe('parseWelcomeVoiceAnswer', () => {
  it('parses a clean voice object (voice fields only)', () => {
    const answer = JSON.stringify({
      greeting: 'Hi Barton,',
      villageLine: 'Hale is the village around your family',
      closingNote: 'reply any time',
    });
    expect(parseWelcomeVoiceAnswer(answer)).toEqual({
      greeting: 'Hi Barton,',
      villageLine: 'Hale is the village around your family',
      closingNote: 'reply any time',
    });
  });

  it('rejects an unknown/extra field and a missing field (→ deterministic fallback)', () => {
    expect(
      parseWelcomeVoiceAnswer(
        JSON.stringify({ greeting: 'a', villageLine: 'b', closingNote: 'c', link: 'https://x.example' }),
      ),
    ).toBeNull();
    expect(parseWelcomeVoiceAnswer(JSON.stringify({ greeting: 'a', villageLine: 'b' }))).toBeNull();
    expect(parseWelcomeVoiceAnswer('not json')).toBeNull();
  });
});

describe('welcomeVoiceContext / factSlots (rule #1: coarse intake only)', () => {
  it('hands the model only the first-name token + coarse place/stage — no child name/DOB', () => {
    const ctx = welcomeVoiceContext(content());
    expect(ctx).toEqual({ firstName: 'Barton', place: 'your neighbourhood', stage: 'the toddler years' });
    // No date-of-birth-shaped or precise field can appear.
    expect(JSON.stringify(ctx)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('grounds the lint on the coarse phrases it was handed', () => {
    expect(welcomeVoiceFactSlots(content())).toEqual(['Barton', 'your neighbourhood', 'the toddler years']);
  });
});
