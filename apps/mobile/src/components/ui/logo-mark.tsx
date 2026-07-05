import { Image } from 'expo-image';

/**
 * The Hale brand chip: the white sea-turtle on its Prussian field, as a rounded
 * square. The chip carries its own dark ground, so it reads on both the light and
 * dark shells without adapting. Decorative beside the "Hale" wordmark — the
 * wordmark carries the accessible name.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <Image
      source={require('../../../assets/images/icon.png')}
      accessibilityIgnoresInvertColors
      style={{ width: size, height: size, borderRadius: 8 }}
    />
  );
}
