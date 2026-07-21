import { Image } from 'expo-image';

/**
 * The village illustration — the product-owner-approved art of a warm coastal cluster
 * of homes. A transparent (arch-masked) PNG composed directly on the theme background
 * (no card, border, or fill), so it reads clean on both the light and dark shells.
 * Decorative — the surrounding copy carries the accessible name. Square art board: pass
 * `width` and the height matches.
 */
export function VillageHouses({ width = 260 }: { width?: number }) {
  return (
    <Image
      source={require('../../../assets/illustrations/village-illustration.png')}
      accessibilityIgnoresInvertColors
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      contentFit="contain"
      style={{ width, height: width }}
    />
  );
}
