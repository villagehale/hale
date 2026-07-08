import Constants from 'expo-constants';
import { AppleMaps, GoogleMaps } from 'expo-maps';
import { Image, Platform, View } from 'react-native';

import type { VillageCandidateView } from '@/lib/api-types';
import { VILLAGE_MAP_ZOOM, mapPointFor } from '@/lib/village-map';

// expo-maps on Android renders a blank grey tile without a configured Google
// Maps key (app.json android.config.googleMaps.apiKey — absent today; builds
// are iOS-only). No key -> fall through to the static/nothing fallback: nothing
// is honest, a broken map box is not.
const ANDROID_MAPS_KEY_CONFIGURED = Boolean(
  (
    Constants.expoConfig?.android?.config as
      | { googleMaps?: { apiKey?: string } }
      | undefined
  )?.googleMaps?.apiKey,
);

/**
 * The interactive Village map for the detail sheet (native only) — plots ONE
 * marker at the candidate's already-resolved PUBLIC venue coordinate (a library, a
 * pool), never the family's location (rule #1). A candidate with no coordinate (an
 * online / no-venue activity, an unresolved geocode, or a teen-redacted card whose
 * lat/lng are nulled at the mapper) renders NOTHING — never a broken/empty map box.
 *
 * `staticMapUri` is the web/no-native fallback path: on RN-web (icon.web.tsx
 * convention) the platform variant renders the static thumbnail instead of this
 * native module. Passed through here so the ONE call site stays simple. Native
 * ignores it — it shows the live interactive map.
 */
export function VillageMap({
  candidate,
  staticMapUri,
}: {
  candidate: VillageCandidateView;
  staticMapUri: string | null;
}) {
  // staticMapUri is the web fallback (see village-map.web.tsx); native uses coords.
  void staticMapUri;
  const point = mapPointFor(candidate);
  if (!point) return null;

  const cameraPosition = {
    coordinates: { latitude: point.lat, longitude: point.lng },
    zoom: VILLAGE_MAP_ZOOM,
  };

  return (
    <View className="mb-3 h-32 w-full overflow-hidden rounded-lg border border-rule">
      {Platform.OS === 'ios' ? (
        <AppleMaps.View
          style={{ flex: 1 }}
          cameraPosition={cameraPosition}
          markers={[
            {
              coordinates: { latitude: point.lat, longitude: point.lng },
              title: point.title ?? undefined,
            },
          ]}
          uiSettings={{ myLocationButtonEnabled: false }}
        />
      ) : Platform.OS === 'android' && ANDROID_MAPS_KEY_CONFIGURED ? (
        <GoogleMaps.View
          style={{ flex: 1 }}
          cameraPosition={cameraPosition}
          markers={[
            {
              coordinates: { latitude: point.lat, longitude: point.lng },
              title: point.title ?? undefined,
            },
          ]}
          uiSettings={{ myLocationButtonEnabled: false }}
        />
      ) : staticMapUri ? (
        <Image
          source={{ uri: staticMapUri }}
          accessibilityLabel={`Map showing ${point.title ?? 'the venue'}`}
          style={{ flex: 1 }}
          resizeMode="cover"
        />
      ) : null}
    </View>
  );
}
