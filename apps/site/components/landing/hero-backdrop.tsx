import Image from 'next/image';
import village from '~/assets/village-illustration-alpha.png';

/**
 * Full-bleed hero backdrop. The village illustration (transparent surround) is
 * staged over a warm cream gradient so it reads as one scene, with a slow
 * Ken-Burns drift for life and a navy-tinted gradient at the bottom so the
 * bottom-anchored hero copy stays legible (WCAG-AA over the lower band).
 *
 * MEDIA SWAP — promoting the hero to a real film/panorama is a one-file change:
 * drop `hero.mp4` (+ `hero-poster.png`) or `hero-panorama.png` into ~/assets and
 * swap ONLY the <Image> below for the <video> in the commented slot. Keep
 * muted + loop + playsInline + a poster (the poster doubles as the
 * reduced-motion still frame). The cream base, Ken-Burns class, and navy overlay
 * all stay exactly as they are.
 */
export function HeroBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {/* warm cream stage — fills where the illustration is transparent */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, #F7F1E6 0%, #FDFCFA 62%)' }}
      />

      <Image
        src={village}
        alt=""
        fill
        priority
        sizes="100vw"
        className="hale-ken-burns object-cover object-center"
      />

      {/* ── MEDIA SWAP SLOT ──────────────────────────────────────────────────
          When a real hero film lands, delete the <Image> above and use:

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

      {/* navy-tinted legibility overlay — transparent up top, deepest at the
          bottom band where the copy sits */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to top, rgba(23,41,74,0.9) 0%, rgba(23,41,74,0.78) 16%, rgba(23,41,74,0.55) 34%, rgba(23,41,74,0.24) 48%, rgba(23,41,74,0) 62%)',
        }}
      />

      {/* left-column scrim — keeps the bottom-left copy legible while the art on
          the right stays bright */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to right, rgba(23,41,74,0.6) 0%, rgba(23,41,74,0.28) 26%, rgba(23,41,74,0) 52%)',
        }}
      />
    </div>
  );
}
