import Image from 'next/image';

/**
 * The Hale turtle mascot (design asset library). ALWAYS the `-alpha` (transparent)
 * variants so it drops cleanly onto warm/cream cards in both light and dark mode.
 * Purely decorative — `alt=""` + aria-hidden so it never blocks content or is
 * announced; the surrounding copy carries the meaning.
 *
 * Pose vocabulary (subset used by the product surfaces):
 *   wave      — greetings / friendly tips
 *   worried   — empty / "nothing found" states
 *   celebrate — milestone reached / celebrations
 *   swim      — calm default
 */
export type MascotPose = 'wave' | 'worried' | 'celebrate' | 'swim';

const SRC: Record<MascotPose, string> = {
  wave: '/mascot/hale-turtle-wave-alpha.png',
  worried: '/mascot/hale-turtle-worried-alpha.png',
  celebrate: '/mascot/hale-turtle-celebrate-alpha.png',
  swim: '/mascot/hale-turtle-swim-alpha.png',
};

export function Mascot({
  pose,
  size = 96,
  className,
}: {
  pose: MascotPose;
  /** Rendered square size in px; the source is 1254² so we only ever scale down. */
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src={SRC[pose]}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={className}
      draggable={false}
    />
  );
}
