import Image from 'next/image';
import village from '~/assets/village-illustration-alpha.png';

/**
 * Full-viewport hero backdrop. The village illustration is a SQUARE artwork with
 * a transparent surround, so it must be STAGED (contained, crisp, anchored to
 * the scene's upper right) over the warm gradient — never object-cover'd
 * full-bleed, which upscales it into blur and shows mostly its transparent
 * margins. A slow Ken-Burns drift on the wrapper gives it life; the navy
 * bottom band keeps the bottom-anchored copy legible (WCAG-AA over the band).
 *
 * MEDIA SWAP — promoting the hero to a real film/panorama is a one-file change:
 * drop `hero.mp4` (+ `hero-poster.png`) or a wide `hero-panorama.png` into
 * ~/assets and replace the staged <div> below with the commented full-bleed
 * slot (a true panorama IS meant to be object-cover'd). Keep muted + loop +
 * playsInline + poster (the poster doubles as the reduced-motion still frame).
 */
export function HeroBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {/* warm stage — golden sky falling into warm white */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, #F2E9D8 0%, #FBF6EC 48%, #FDFCFA 100%)' }}
      />

      {/* staged village art — contained (crisp), anchored upper-right of the
          scene on desktop, centered above the copy band on small screens */}
      <div className="hale-ken-burns absolute inset-x-[-6%] top-[4%] bottom-[34%] md:inset-x-auto md:right-[2%] md:top-[6%] md:bottom-[22%] md:w-[56%]">
        <Image
          src={village}
          alt=""
          fill
          priority
          quality={90}
          sizes="(min-width: 768px) 56vw, 112vw"
          className="object-contain object-bottom md:object-right-bottom"
        />
      </div>

      {/* ── MEDIA SWAP SLOT (full-bleed panorama/film only) ──────────────────
          <video
            className="hale-ken-burns absolute inset-0 h-full w-full object-cover object-center"
            autoPlay
            muted
            loop
            playsInline
            poster="/hero-poster.png"
          >
            <source src="/hero.mp4" type="video/mp4" />
          </video>
          ──────────────────────────────────────────────────────────────────── */}

      {/* navy-tinted legibility band — transparent above the art, deepest where
          the bottom-anchored copy sits */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, rgba(23,41,74,0.92) 0%, rgba(23,41,74,0.8) 14%, rgba(23,41,74,0.55) 30%, rgba(23,41,74,0.2) 44%, rgba(23,41,74,0) 56%)',
        }}
      />

      {/* soft left scrim — settles the copy column without darkening the art */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to right, rgba(23,41,74,0.42) 0%, rgba(23,41,74,0.16) 24%, rgba(23,41,74,0) 46%)',
        }}
      />
    </div>
  );
}
