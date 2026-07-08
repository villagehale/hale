/**
 * The map-image response → data-URI fold, in its own RN-free module so the
 * pure-logic vitest runner never imports react-native (Rollup cannot parse
 * RN's Flow syntax). ONLY a 200 with actual bytes yields a URI: a 204 "no map"
 * has res.ok === true but MUST render nothing — an empty data URI is truthy
 * and would paint an empty framed box on every detail sheet while the Static
 * Maps API is still disabled.
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
