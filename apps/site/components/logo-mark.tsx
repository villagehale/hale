import Image from 'next/image';
import logo from '~/assets/hale-logo.jpeg';

/**
 * The Hale brand mark: the white sea-turtle on its navy tile, as a rounded
 * square (~30% radius per the design handoff). The tile carries its own dark
 * ground, so it reads on the warm page without adapting. Decorative beside the
 * "Hale" wordmark — the wordmark carries the accessible name.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <Image
      src={logo}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '30%',
        display: 'block',
      }}
    />
  );
}
