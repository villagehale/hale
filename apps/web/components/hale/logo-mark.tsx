import Image from 'next/image';
import icon from '~/app/icon.png';

/**
 * The Hale brand chip: the white sea-turtle on its Prussian field, as a rounded
 * square. The chip carries its own dark ground, so it reads on both the cream
 * (light) and Prussian (dark) shells without adapting. Decorative beside the
 * "Hale" wordmark — the wordmark carries the accessible name.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <Image
      src={icon}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--r-md)',
        display: 'block',
      }}
    />
  );
}
