import { describe, expect, it } from 'vitest';
import { primaryTextTarget } from './primary-cta.js';
import { INTAKE_PREFILL } from './text-entry.js';

/**
 * VIL-385 part 1 — the primary Text Hale door.
 *
 * A phone opens the messaging app with the locked prefill, in the form that
 * OS reads. Desktop stays on /text (the page that already shows the QR and
 * the number). The body is whatever the caller passes: EN is INTAKE_PREFILL,
 * FR is the existing sentGloss, handed in so this module stays copy-free.
 */

const NUMBER = '+16475551234';
const FR = 'Salut Hale, qu\u2019est-ce qui se passe ?';

function bodyOf(href: string): string {
  const raw = href.includes('?')
    ? href.slice(href.indexOf('?') + 1).replace(/^&/, '')
    : href.slice(href.indexOf('&') + 1);
  const value = new URLSearchParams(raw).get('body');
  if (value === null) throw new Error(`missing body in ${href}`);
  return value;
}

describe('primaryTextTarget', () => {
  it('opens iOS Messages with &body= and the locked English hello', () => {
    const target = primaryTextTarget({
      platform: 'apple',
      smsNumber: NUMBER,
      prefill: INTAKE_PREFILL,
      source: null,
      textPath: '/text',
    });
    expect(target.composer).toBe(true);
    expect(target.href).toBe(`sms:${NUMBER}&body=Hey%20Hale%2C%20what%27s%20going%20on%3F`);
    expect(target.href).not.toContain('?');
    expect(bodyOf(target.href)).toBe(INTAKE_PREFILL);
  });

  it('opens Android Messages with ?body= and the same hello', () => {
    const target = primaryTextTarget({
      platform: 'android',
      smsNumber: NUMBER,
      prefill: INTAKE_PREFILL,
      source: null,
      textPath: '/text',
    });
    expect(target.composer).toBe(true);
    expect(target.href).toBe(`sms:${NUMBER}?body=Hey%20Hale%2C%20what%27s%20going%20on%3F`);
    expect(target.href).not.toContain('?&');
    expect(bodyOf(target.href)).toBe(INTAKE_PREFILL);
  });

  it('puts the French twin in the body on a French page, venue token included', () => {
    const target = primaryTextTarget({
      platform: 'apple',
      smsNumber: NUMBER,
      prefill: FR,
      source: 'earlyon-richmondhill',
      textPath: '/fr/text',
    });
    expect(bodyOf(target.href)).toBe(`${FR} (via earlyon-richmondhill)`);
    expect(target.href).toContain('%E2%80%99');
    expect(target.href).not.toContain('\u2019');
  });

  it('keeps every desktop on /text, including the Mac where Messages.app exists', () => {
    for (const platform of ['desktop-mac', 'desktop-other', 'unknown'] as const) {
      const target = primaryTextTarget({
        platform,
        smsNumber: NUMBER,
        prefill: INTAKE_PREFILL,
        source: null,
        textPath: '/text',
      });
      expect(target, platform).toEqual({ href: '/text', composer: false });
    }
  });

  it('keeps a desktop reader on the locale-prefixed /text page, with the venue tag', () => {
    expect(
      primaryTextTarget({
        platform: 'desktop-other',
        smsNumber: NUMBER,
        prefill: FR,
        source: 'earlyon-richmondhill',
        textPath: '/fr/text',
      }),
    ).toEqual({ href: '/fr/text?s=earlyon-richmondhill', composer: false });
  });

  it('does not emit a broken sms: link when the number is empty', () => {
    const target = primaryTextTarget({
      platform: 'apple',
      smsNumber: '',
      prefill: INTAKE_PREFILL,
      source: null,
      textPath: '/text',
    });
    expect(target.href).toBe('/text');
    expect(target.href).not.toContain('sms:');
    expect(target.composer).toBe(false);
  });
});
