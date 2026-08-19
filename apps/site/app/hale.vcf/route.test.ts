import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route.js';

/**
 * /hale.vcf — the contact card the /text page offers to save. Two honest states,
 * the same two the page itself has:
 *
 *   number live  → a vCard the phone can save, turtle photo attached.
 *   number unset → 404, and the page hides the button. Never a card with a blank
 *                  or half-written number in it.
 *
 * The fold and field assertions live in lib/contact-card.test.ts; what this file
 * adds is the wiring — the real photo asset, the real env read, the headers a
 * phone needs to treat the response as a contact rather than a text file.
 */

const NUMBER = '+16475551234';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function get(number: string | undefined): Promise<Response> {
  if (number === undefined) vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '');
  else vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  return GET();
}

describe('/hale.vcf (number provisioned)', () => {
  it('serves a vCard the phone will offer to save, named Hale.vcf', async () => {
    const res = await get(NUMBER);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/vcard; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Hale.vcf"');
    const body = await res.text();
    expect(body.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
    expect(body).toContain(`TEL;TYPE=CELL:${NUMBER}`);
  });

  it('carries the turtle asset itself, byte for byte', async () => {
    // lib/contact-photo.ts is a hand-regenerated copy of the JPEG (webpack will
    // not let the route read the file at runtime), so this is also the drift
    // gate: change the photo without regenerating the module and this fails.
    const asset = readFileSync(
      fileURLToPath(new URL('../../assets/hale-contact-photo.jpeg', import.meta.url)),
    );
    // JPEG SOI + APP marker — the asset is an image, not a stray file.
    expect(asset.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // Phones and carriers both dislike heavy cards; the shipped photo is a 240 px
    // downscale, not the 73 KB original.
    expect(asset.byteLength).toBeLessThan(80_000);

    const body = await (await get(NUMBER)).text();
    const photoLine = body
      .replace(/\r\n /g, '')
      .split('\r\n')
      .find((line) => line.startsWith('PHOTO;ENCODING=b;TYPE=JPEG:'));
    const served = Buffer.from(
      (photoLine ?? '').slice('PHOTO;ENCODING=b;TYPE=JPEG:'.length),
      'base64',
    );
    expect(served.equals(asset)).toBe(true);
  });

  it('folds the real card, photo and all, to 75 octets a line', async () => {
    // The generator's own test proves the rule; this proves the shipped asset
    // goes through it — an unfolded photo is the failure iOS shows as "no avatar".
    const body = await (await get(NUMBER)).text();
    const lines = body.split('\r\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(20);
    for (const line of lines) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('/hale.vcf (number not provisioned)', () => {
  it('404s rather than serving a card with no number in it', async () => {
    for (const value of [undefined, 'coming soon', '+1']) {
      const res = await get(value);
      expect(res.status, `for ${String(value)}`).toBe(404);
      expect(await res.text()).not.toContain('BEGIN:VCARD');
    }
  });

  it('says why it is missing rather than 404ing blank', async () => {
    const res = await get(undefined);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toContain('not provisioned');
  });
});
