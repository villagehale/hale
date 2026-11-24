import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  conversionsPageViewEnabled,
  metaPixelIdFromEnv,
  metaPixelIdWhenConversionsEnabled,
  metaPixelIdsFromEnv,
  metaPixelIdsWhenConversionsEnabled,
} from './meta-pixel.js';

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

const successPage = readFileSync(
  fileURLToPath(new URL('../../app/[locale]/checkout/success/page.tsx', import.meta.url)),
  'utf8',
);

const privacy = readFileSync(
  fileURLToPath(new URL('../../app/[locale]/privacy/page.tsx', import.meta.url)),
  'utf8',
);

const NEW_PIXEL_ID = '2041301346827688';

describe('NEXT_PUBLIC_META_PIXEL_ID list', () => {
  it('keeps a single id, and trims it', () => {
    expect(metaPixelIdsFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: PIXEL_ID })).toEqual([PIXEL_ID]);
    expect(metaPixelIdFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: `  ${PIXEL_ID}  ` })).toBe(PIXEL_ID);
    expect(metaPixelIdsFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: `  ${PIXEL_ID}  ` })).toEqual([
      PIXEL_ID,
    ]);
  });

  it('reads two ids, drops junk and empties, and dedupes', () => {
    expect(
      metaPixelIdsFromEnv({
        NEXT_PUBLIC_META_PIXEL_ID: `${PIXEL_ID}, ${NEW_PIXEL_ID}`,
      }),
    ).toEqual([PIXEL_ID, NEW_PIXEL_ID]);
    expect(
      metaPixelIdsFromEnv({
        NEXT_PUBLIC_META_PIXEL_ID: ` ${PIXEL_ID} , nope, , 12a, ${PIXEL_ID}, ${NEW_PIXEL_ID} `,
      }),
    ).toEqual([PIXEL_ID, NEW_PIXEL_ID]);
    expect(metaPixelIdsFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: ' , abc, ' })).toEqual([]);
    expect(metaPixelIdFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: ' , abc, ' })).toBeNull();
    expect(
      metaPixelIdFromEnv({
        NEXT_PUBLIC_META_PIXEL_ID: `nope, ${PIXEL_ID}, ${NEW_PIXEL_ID}`,
      }),
    ).toBe(PIXEL_ID);
  });

  it('still returns one id from the conversions gate, and the full list beside it', () => {
    expect(
      metaPixelIdWhenConversionsEnabled({
        NEXT_PUBLIC_CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: `${PIXEL_ID}, ${NEW_PIXEL_ID}`,
      }),
    ).toBe(PIXEL_ID);
    expect(
      metaPixelIdsWhenConversionsEnabled({
        NEXT_PUBLIC_CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: `${PIXEL_ID}, ${NEW_PIXEL_ID}`,
      }),
    ).toEqual([PIXEL_ID, NEW_PIXEL_ID]);
    expect(
      metaPixelIdsWhenConversionsEnabled({
        NEXT_PUBLIC_META_PIXEL_ID: `${PIXEL_ID},${NEW_PIXEL_ID}`,
      }),
    ).toEqual([]);
  });
});

describe('Meta Pixel id is env-driven', () => {
  it('is null unless a conversions flag is exact true', () => {
    expect(metaPixelIdWhenConversionsEnabled({ NEXT_PUBLIC_META_PIXEL_ID: PIXEL_ID })).toBeNull();
    expect(conversionsPageViewEnabled({ CONVERSIONS_API_ENABLED: 'true' })).toBe(true);
    expect(conversionsPageViewEnabled({ NEXT_PUBLIC_CONVERSIONS_API_ENABLED: 'true' })).toBe(true);
    expect(conversionsPageViewEnabled({ NEXT_PUBLIC_CONVERSIONS_API_ENABLED: 'TRUE' })).toBe(false);
    expect(
      metaPixelIdWhenConversionsEnabled({
        CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: PIXEL_ID,
      }),
    ).toBe(PIXEL_ID);
    expect(
      metaPixelIdWhenConversionsEnabled({
        NEXT_PUBLIC_CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: PIXEL_ID,
      }),
    ).toBe(PIXEL_ID);
  });
});

describe('Meta Pixel PageView on both sites', () => {
  it('installs from the marketing consent banner, not as a server-head tag', () => {
    expect(layout).not.toContain('connect.facebook.net');
    expect(layout).toContain('metaPixelIdsWhenConversionsEnabled');
    expect(consent).toContain('installMetaPixel');
    expect(consent).toContain('pixelId');
    expect(consent).toContain('NEXT_PUBLIC_CONVERSIONS_API_ENABLED');
    expect(consent).toContain('NEXT_PUBLIC_META_PIXEL_ID');
    expect(successPage).toContain('metaPixelIdsFromEnv');
  });

  it('loads on the product app behind the conversions flag', () => {
    expect(webLayout).toContain('MetaPixel');
    expect(webLayout).toContain('metaPixelIdsWhenConversionsEnabled');
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
