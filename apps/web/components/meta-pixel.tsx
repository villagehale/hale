'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import {
  installMetaPixel,
  metaPixelAllowedOn,
  setMetaPixelAllowed,
} from '~/lib/analytics/meta-pixel-client';

/**
 * Loads the Meta Pixel PageView snippet when the conversions flag handed us an id,
 * and only on a path `metaPixelAllowedOn` admits. A later client-side visit to any
 * other path revokes it.
 */
export function MetaPixel({ pixelId }: { pixelId: string }): null {
  const pathname = usePathname();
  useEffect(() => {
    const allowed = metaPixelAllowedOn(pathname, window.location.search, window.location.hash);
    if (allowed) installMetaPixel(pixelId);
    setMetaPixelAllowed(allowed);
  }, [pixelId, pathname]);
  return null;
}
