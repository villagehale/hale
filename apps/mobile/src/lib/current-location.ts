import * as Location from 'expo-location';

import { type CoarsePlace, cityFromReverseGeocode } from './village-region';

/**
 * Resolve the device's location to a COARSE {city, province} ENTIRELY on-device,
 * for the region switcher's "Use my current location" row.
 *
 * PRIVACY CONTRACT (hard rule #1 — non-negotiable). Precise coordinates NEVER leave
 * the phone, are never logged, and are never stored. This handler:
 *   1. asks for foreground permission (denial → { status: 'denied' } — the caller
 *      shows a calm "search for your city instead" note, never a coordinate);
 *   2. reads a single fix at the LOWEST accuracy that still yields a city
 *      (Accuracy.Lowest ≈ 3 km — deliberately never a precise fix);
 *   3. reverse-geocodes it to a city/province ON-DEVICE (reverseGeocodeAsync — no
 *      Hale server call);
 *   4. extracts ONLY the coarse {city, province} and lets the coordinate object go
 *      out of scope immediately — it is never returned, logged, or persisted.
 * The caller sends only {city, province} to the SAME add/setActive area endpoint the
 * typed-city path uses, so the server sees a coarse area identical to a searched one
 * and never a latitude/longitude. Any failure degrades to a calm fallback, never a
 * coordinate leak (this is an explicit best-effort boundary, the rule #8 exception).
 */
export type CoarseLocationResult =
  | { status: 'ok'; place: CoarsePlace }
  | { status: 'denied' }
  | { status: 'unavailable' };

export async function resolveCoarseLocation(): Promise<CoarseLocationResult> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return { status: 'denied' };

  try {
    const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Lowest });
    const addresses = await Location.reverseGeocodeAsync({
      latitude: fix.coords.latitude,
      longitude: fix.coords.longitude,
    });
    // The coordinate object (fix) goes out of scope here — only the coarse name is
    // read out, and nothing about the coordinate is returned or logged (rule #1).
    const place = cityFromReverseGeocode(addresses[0]);
    return place ? { status: 'ok', place } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
