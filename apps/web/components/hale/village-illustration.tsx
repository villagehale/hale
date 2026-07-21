import Image from 'next/image';

/**
 * The onboarding step-4 village illustration. It is the honest fallback for the
 * interactive location map (onboarding-location-map.tsx): when the Maps key is
 * unset (previews / forks) or the Maps script fails to load, the slot shows this
 * exactly as it did before the map shipped — flag-style degradation, never a broken
 * grey box. Fills its positioned parent (the 230px map card).
 */
export function VillageIllustration() {
  return (
    <Image
      src="/village-illustration.png"
      alt=""
      aria-hidden="true"
      fill
      sizes="620px"
      className="object-contain p-4"
    />
  );
}
