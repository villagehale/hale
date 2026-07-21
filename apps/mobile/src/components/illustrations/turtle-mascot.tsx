import { Image } from 'expo-image';

/**
 * "Kai" — the Hale turtle mascot, the product-owner-approved 3D art. A transparent PNG
 * composed directly on the surrounding theme background (no card, border, or fill), so
 * it reads clean on both the light and dark shells. Decorative — the surrounding copy
 * carries the accessible name. Square art board: pass `width` and the height matches;
 * `pose` selects the expression for the context.
 */
const POSES = {
  wave: require('../../../assets/mascot/hale-turtle-wave.png'),
  excited: require('../../../assets/mascot/hale-turtle-excited.png'),
} as const;

export type MascotPose = keyof typeof POSES;

export function TurtleMascot({
  pose = 'wave',
  width = 200,
}: {
  pose?: MascotPose;
  width?: number;
}) {
  return (
    <Image
      source={POSES[pose]}
      accessibilityIgnoresInvertColors
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      contentFit="contain"
      style={{ width, height: width }}
    />
  );
}
