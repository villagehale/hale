import { useEffect, useState } from 'react';

import { API_BASE } from './api-client';
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

/**
 * The response → data-URI fold, pure for testing. ONLY a 200 with actual bytes
 * yields a URI: a 204 "no map" has res.ok === true but MUST render nothing —
 * an empty data URI is truthy and would paint an empty framed box on every
 * detail sheet while the Static Maps API is still disabled.
 */
export function mapImageDataUri(
  status: number,
  contentType: string | null,
  buffer: ArrayBuffer,
): string | null {
  if (status !== 200 || buffer.byteLength === 0) return null;
  return `data:${contentType ?? 'image/png'};base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa exists in the Hermes/RN runtime; the bytes are already 8-bit-clamped.
  return btoa(binary);
}
