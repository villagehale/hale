import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { metaPixelIdWhenConversionsEnabled } from './meta-pixel.js';

const PIXEL_ID = '1460101092968766';

const layout = readFileSync(
  fileURLToPath(new URL('../../app/[locale]/layout.tsx', import.meta.url)),
  'utf8',
);

const webLayout = readFileSync(
  fileURLToPath(new URL('../../../web/app/layout.tsx', import.meta.url)),
  'utf8',
);

const webPixel = readFileSync(
  fileURLToPath(new URL('../../../web/components/meta-pixel.tsx', import.meta.url)),
  'utf8',
);

const consent = readFileSync(
  fileURLToPath(new URL('../../components/consent-banner.tsx', import.meta.url)),
  'utf8',
);

const privacy = readFileSync(
  fileURLToPath(new URL('../../app/[locale]/privacy/page.tsx', import.meta.url)),
  'utf8',
);

describe('Meta Pixel id is env-driven', () => {
  it('is null unless the conversions flag is exact true', () => {
    expect(metaPixelIdWhenConversionsEnabled({ NEXT_PUBLIC_META_PIXEL_ID: PIXEL_ID })).toBeNull();
    expect(
      metaPixelIdWhenConversionsEnabled({
        CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: PIXEL_ID,
      }),
    ).toBe(PIXEL_ID);
  });
});

describe('Meta Pixel PageView on both sites', () => {
  it('installs from the marketing consent banner, not as a server-head tag', () => {
    expect(layout).not.toContain('connect.facebook.net');
    expect(layout).toContain('metaPixelId');
    expect(consent).toContain('installMetaPixel');
    expect(consent).toContain('pixelId');
  });

  it('loads on the product app behind the conversions flag', () => {
    expect(webLayout).toContain('MetaPixel');
    expect(webLayout).toContain('metaPixelIdWhenConversionsEnabled');
    expect(webPixel).toContain('installMetaPixel');
  });
});

describe('the privacy policy names the pixel on both hosts', () => {
  it('discloses Meta Pixel PageView and CAPI Purchase, with no child data', () => {
    expect(privacy).toContain('<strong>Meta</strong>');
    expect(privacy).toContain(PIXEL_ID);
    expect(privacy).toContain('villagehale.com');
    expect(privacy).toContain('app.villagehale.com');
    expect(privacy).toMatch(/no child/i);
  });
});
