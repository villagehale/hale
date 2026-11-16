import { describe, expect, it } from 'vitest';
import { metaPixelIdFromEnv, metaPixelIdWhenConversionsEnabled } from './meta-pixel.js';

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
    expect(metaPixelIdFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766' })).toBe(
      '1460101092968766',
    );
  });
});
