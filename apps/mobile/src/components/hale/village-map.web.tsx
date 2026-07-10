import { Image } from 'expo-image';
import { View } from 'react-native';

import type { VillageCandidateView } from '@/lib/api-types';
import { mapPointFor } from '@/lib/village-map';

/**
 * RN-web fallback for the Village map (icon.web.tsx convention): expo-maps has NO
 * web support, so the web preview never imports it. Instead it renders the SAME
 * static Static-Maps thumbnail the detail sheet already fetched (rule #1: a public
 * venue point, streamed through the server so the key never reaches the client),
 * or NOTHING when there is no thumbnail / no coordinate — never a broken map box.
 */
export function VillageMap({
  candidate,
  staticMapUri,
}: {
  candidate: VillageCandidateView;
  staticMapUri: string | null;
}) {
  // No coordinate → no venue → nothing to show (matches the native variant).
  if (!mapPointFor(candidate) || !staticMapUri) return null;
  return (
    <View className="mb-3 h-32 w-full overflow-hidden rounded-lg border border-rule">
      <Image
        source={{ uri: staticMapUri }}
        accessibilityLabel={`Map showing ${candidate.venueName ?? candidate.title}`}
        style={{ flex: 1 }}
        contentFit="cover"
      />
    </View>
  );
}
