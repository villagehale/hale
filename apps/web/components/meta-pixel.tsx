'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { installMetaPixel, metaPixelAllowedOn } from '~/lib/analytics/meta-pixel-client';

/**
 * Loads the Meta Pixel PageView snippet when the conversions flag handed us an id,
 * and only on a path `metaPixelAllowedOn` admits.
 */
export function MetaPixel({ pixelId }: { pixelId: string }): null {
  const pathname = usePathname();
  useEffect(() => {
    if (!metaPixelAllowedOn(pathname, window.location.search, window.location.hash)) return;
    installMetaPixel(pixelId);
  }, [pixelId, pathname]);
  return null;
}
