'use client';

import { useEffect } from 'react';
import { installMetaPixel } from '~/lib/analytics/meta-pixel-client';

/** Loads the Meta Pixel PageView snippet when the conversions flag handed us an id. */
export function MetaPixel({ pixelId }: { pixelId: string }): null {
  useEffect(() => {
    installMetaPixel(pixelId);
  }, [pixelId]);
  return null;
}
