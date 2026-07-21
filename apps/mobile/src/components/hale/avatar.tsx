import { Image } from 'expo-image';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';

/**
 * An avatar: the photo when there is one, else an initials disc. The initials render on
 * the disc and the photo overlays them, so a slow or failed photo load falls back to the
 * initials with no flash of empty. `size` is the diameter. Shared by every avatar
 * surface (parent + child) so the photo/initials fallback is identical everywhere.
 */
export function Avatar({
  photoUrl,
  initials,
  size = 38,
}: {
  photoUrl?: string | null;
  initials: string;
  size?: number;
}) {
  return (
    <View
      className="items-center justify-center overflow-hidden rounded-full bg-chip-blue"
      style={{ width: size, height: size }}
    >
      <AppText
        className="text-brand"
        style={{ fontFamily: 'InstrumentSans_700Bold', fontSize: Math.round(size * 0.4) }}
      >
        {initials}
      </AppText>
      {photoUrl ? (
        <Image
          source={{ uri: photoUrl }}
          accessibilityIgnoresInvertColors
          contentFit="cover"
          style={{ position: 'absolute', width: size, height: size }}
        />
      ) : null}
    </View>
  );
}
