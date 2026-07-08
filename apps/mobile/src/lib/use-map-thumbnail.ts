import { useEffect, useState } from 'react';

import { API_BASE } from './api-client';
import { mapImageDataUri } from './map-image';
import { TOKEN_KEY, tokenStorage } from './token-storage';

/**
 * Fetches the Static Maps thumbnail for a candidate's PUBLIC venue point and
 * returns a data URI to render — but ONLY on a 200. The server route streams the
 * bytes so the Maps key never reaches the app (rule #1); we fetch with the Bearer
 * token and inline the bytes as a data URI so no unauthenticated image URL is ever
 * exposed.
 *
 * Graceful degradation: the Static Maps API may not be enabled yet (the route
 * returns 204 / any non-200 → "no map"). Any non-200, a transport error, or a
 * missing candidate id yields null and the caller renders NOTHING — no spinner, no
 * error state. A thumbnail simply appears once the API is enabled, with no release.
 */
export function useMapThumbnail(candidateId: string | null): string | null {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    if (!candidateId || !API_BASE) {
      setUri(null);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const token = await tokenStorage.get(TOKEN_KEY);
        const headers = new Headers();
        if (token) headers.set('authorization', `Bearer ${token}`);
        const res = await fetch(
          `${API_BASE}/api/mobile/village/map-image?candidateId=${candidateId}`,
          { headers },
        );
        if (cancelled) return;
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        setUri(mapImageDataUri(res.status, res.headers.get('content-type'), buffer));
      } catch {
        // A transport error is the same silent "no map" state — never surfaced.
        if (!cancelled) setUri(null);
      }
    })();

    return () => {
      cancelled = true;
      setUri(null);
    };
  }, [candidateId]);

  return uri;
}
