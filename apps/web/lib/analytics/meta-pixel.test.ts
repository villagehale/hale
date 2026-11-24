import { describe, expect, it } from 'vitest';
import {
  metaPixelIdFromEnv,
  metaPixelIdWhenConversionsEnabled,
  metaPixelIdsFromEnv,
  metaPixelIdsWhenConversionsEnabled,
} from './meta-pixel.js';

const OLD_ID = '1460101092968766';
const NEW_ID = '2041301346827688';

describe('NEXT_PUBLIC_META_PIXEL_ID list', () => {
  it('keeps a single id', () => {
    expect(metaPixelIdsFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: `  ${OLD_ID}  ` })).toEqual([OLD_ID]);
    expect(metaPixelIdFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: OLD_ID })).toBe(OLD_ID);
  });

  it('reads two ids, drops junk and spaces, and dedupes', () => {
    expect(
      metaPixelIdsFromEnv({
        NEXT_PUBLIC_META_PIXEL_ID: ` ${OLD_ID} , nope, , ${OLD_ID}, ${NEW_ID} `,
      }),
    ).toEqual([OLD_ID, NEW_ID]);
    expect(metaPixelIdFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: `nope, ${OLD_ID}, ${NEW_ID}` })).toBe(
      OLD_ID,
    );
    expect(metaPixelIdsFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: ' , abc, ' })).toEqual([]);
  });

  it('gates the list the same way as the single id', () => {
    expect(
      metaPixelIdsWhenConversionsEnabled({
        NEXT_PUBLIC_META_PIXEL_ID: `${OLD_ID},${NEW_ID}`,
      }),
    ).toEqual([]);
    expect(
      metaPixelIdWhenConversionsEnabled({
        CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: `${OLD_ID}, ${NEW_ID}`,
      }),
    ).toBe(OLD_ID);
    expect(
      metaPixelIdsWhenConversionsEnabled({
        NEXT_PUBLIC_CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: `${OLD_ID}, ${NEW_ID}`,
      }),
    ).toEqual([OLD_ID, NEW_ID]);
  });
});

describe('metaPixelIdWhenConversionsEnabled', () => {
  it('is null unless the conversions flag is exact true and the public id is set', () => {
    expect(
      metaPixelIdWhenConversionsEnabled({ NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766' }),
    ).toBeNull();
    expect(
      metaPixelIdWhenConversionsEnabled({
        CONVERSIONS_API_ENABLED: 'true',
      }),
    ).toBeNull();
    expect(
      metaPixelIdWhenConversionsEnabled({
        CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
      }),
    ).toBe('1460101092968766');
    expect(
      metaPixelIdWhenConversionsEnabled({
        NEXT_PUBLIC_CONVERSIONS_API_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
      }),
    ).toBe('1460101092968766');
    expect(metaPixelIdFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766' })).toBe(
      '1460101092968766',
    );
  });
});
