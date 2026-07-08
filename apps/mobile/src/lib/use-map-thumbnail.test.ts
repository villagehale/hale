import { describe, expect, it } from 'vitest';
import { mapImageDataUri } from './use-map-thumbnail';

/**
 * The degradation contract: while the Static Maps API is disabled the proxy
 * answers 204, and the sheet must render NOTHING — a 204 passes res.ok, and an
 * empty data URI is truthy, so both traps are pinned here.
 */
describe('mapImageDataUri', () => {
  it('returns null for a 204 no-map response (res.ok is true — the trap)', () => {
    expect(mapImageDataUri(204, null, new ArrayBuffer(0))).toBeNull();
  });

  it('returns null for a 200 with an empty body', () => {
    expect(mapImageDataUri(200, 'image/png', new ArrayBuffer(0))).toBeNull();
  });

  it('returns null for error statuses', () => {
    expect(mapImageDataUri(403, 'text/plain', new TextEncoder().encode('nope').buffer)).toBeNull();
  });

  it('folds a real 200 into a typed data URI', () => {
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic prefix
    const uri = mapImageDataUri(200, 'image/png', bytes.buffer);
    expect(uri).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`);
  });
});
