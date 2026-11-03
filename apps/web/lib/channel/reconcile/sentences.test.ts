import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Segment, claimReadLocale, segmentSentences } from './sentences';

/**
 * VIL-581 · code owns the sentence boundaries the claim reader numbers. Expected values
 * come from ICU's sentence rules and the masking spec (URL and quote interiors masked,
 * terminators kept, no merge), not from this module's output.
 */

const texts = (segments: readonly Segment[]) => segments.map((s) => s.text);

/** Raw ICU on the same string: the control that proves a mask is what changed the split. */
const rawIcu = (body: string, locale?: string) =>
  [...new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(body)].length;

const TILED: Array<[string, string | undefined]> = [];
function seg(body: string, locale?: string) {
  TILED.push([body, locale]);
  return segmentSentences(body, locale);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('segmentSentences — ICU boundaries per language', () => {
  it('zh splits at 。！？', () => {
    expect(texts(seg('我会继续帮你找。你的体检已经约好了！好吗？', 'zh'))).toEqual([
      '我会继续帮你找。',
      '你的体检已经约好了！',
      '好吗？',
    ]);
  });

  it('es keeps ¿…? whole', () => {
    const out = seg('¿Quieres que vigile esa mañana? Tu cita está reservada.', 'es');
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe('¿Quieres que vigile esa mañana?');
  });

  it('keeps "7:00 a.m. sharp" in one sentence and splits at a newline', () => {
    expect(texts(seg('Registration opens at 7:00 a.m. sharp, so be ready.\nDone.', 'en'))).toEqual([
      'Registration opens at 7:00 a.m. sharp, so be ready.',
      'Done.',
    ]);
  });

  it('ar splits at ". "', () => {
    expect(seg('سأرسل لك رسالة. موعدك محجوز.', 'ar')).toHaveLength(2);
  });
});

describe('segmentSentences — masks', () => {
  it('a URL with "?" stays whole and its trailing "." still ends the sentence', () => {
    const body = 'See https://example.ca/a.b?c=1. Then call.';
    expect(texts(seg(body, 'en'))).toEqual(['See https://example.ca/a.b?c=1.', 'Then call.']);
    expect(rawIcu(body, 'en')).toBe(3);
  });

  it('a mid-sentence URL does not end one (control)', () => {
    expect(seg('Book at https://register.example.org/x.y and call. Done.', 'en')).toHaveLength(2);
  });

  it('a straight-quoted span is not split inside', () => {
    const body = 'Your note said "I will sign her up Monday. Then call." Okay.';
    expect(texts(seg(body, 'en'))).toEqual([
      'Your note said "I will sign her up Monday. Then call."',
      'Okay.',
    ]);
    expect(rawIcu(body, 'en')).toBe(3);
  });

  it('a curly-quoted span is not split inside', () => {
    const body = 'Your note said “I will sign her up Monday. Then call.” Okay.';
    expect(texts(seg(body, 'en'))).toEqual([
      'Your note said “I will sign her up Monday. Then call.”',
      'Okay.',
    ]);
    expect(rawIcu(body, 'en')).toBe(3);
  });

  it('fr guillemets, with the terminator inside or outside the closing mark', () => {
    const inside = 'Vous avez écrit « Je l’inscris lundi. Puis appelez. » D’accord.';
    const out = seg(inside, 'fr');
    expect(out).toHaveLength(2);
    expect(out[0]?.text.endsWith('»')).toBe(true);
    expect(rawIcu(inside, 'fr')).toBe(3);
    expect(
      seg('Vous avez écrit « Je l’inscris lundi. Puis appelez ». D’accord.', 'fr'),
    ).toHaveLength(2);
  });

  it('zh corner brackets 「」 and 『』', () => {
    const corner = '你说「我周一给她报名。然后打电话。」好的。';
    expect(texts(seg(corner, 'zh'))).toEqual(['你说「我周一给她报名。然后打电话。」', '好的。']);
    expect(rawIcu(corner, 'zh')).toBe(3);
    expect(texts(seg('你说『我周一给她报名。然后打电话。』好的。', 'zh'))).toEqual([
      '你说『我周一给她报名。然后打电话。』',
      '好的。',
    ]);
  });
});

describe('segmentSentences — no merge', () => {
  it('a one-word sentence stays its own segment', () => {
    expect(texts(seg('Oui. Votre visite est réservée.', 'fr'))).toEqual([
      'Oui.',
      'Votre visite est réservée.',
    ]);
    expect(seg('Sí. Tu cita está reservada.', 'es')).toHaveLength(2);
  });

  it('pins ICU splitting "M." off its sentence (a later fix must be deliberate)', () => {
    expect(texts(seg('M. Dupuis a confirmé. Merci.', 'fr'))).toEqual([
      'M.',
      'Dupuis a confirmé.',
      'Merci.',
    ]);
  });

  it('a whitespace-only span joins a neighbour and is never numbered', () => {
    const out = seg('\nHello there. Bye.', 'en');
    expect(texts(out)).toEqual(['Hello there.', 'Bye.']);
    expect(out[0]?.start).toBe(0);
    const gap = seg('Hi.  \n\n  Bye.', 'en');
    expect(texts(gap)).toEqual(['Hi.', 'Bye.']);
  });
});

describe('claimReadLocale', () => {
  it('drops a tag ICU rejects, logs it once without the tag, and segmenting still works', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => new Intl.Segmenter('en-a1')).toThrow(RangeError);
    const locale = claimReadLocale('en-a1');
    expect(locale).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ event: 'claim_read_language_rejected' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('en-a1');
    expect(seg('One thing. Two things.', locale)).toHaveLength(2);
  });

  it('canonicalises an accepted tag with no log (positive control)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(claimReadLocale('fr-ca')).toBe('fr-CA');
    expect(warn).not.toHaveBeenCalled();
  });

  it('null is no locale and no log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(claimReadLocale(null)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('segmentSentences — tiling', () => {
  it('every body above: raw spans tile the body, indices are 0..n-1, no text is blank', () => {
    expect(TILED.length).toBeGreaterThan(10);
    for (const [body, locale] of TILED) {
      const out = segmentSentences(body, locale);
      expect(out.map((s) => body.slice(s.start, s.end)).join(''), body).toBe(body);
      expect(
        out.map((s) => s.index),
        body,
      ).toEqual(out.map((_, i) => i));
      for (const s of out) {
        expect(s.text.trim(), body).not.toBe('');
        expect(s.text).toBe(body.slice(s.start, s.end).trim());
      }
    }
  });
});
