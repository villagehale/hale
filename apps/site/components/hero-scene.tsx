/*
 * The hero's "your village" scene: a low Spruce hill, a small cluster of homes
 * (the Village — more than one house, because a village is the point), an
 * Apricot sun on a slow 30s ambient arc, a Sky cloud drifting, and the Hale sea
 * turtle resting among the houses. The sun's arc is the only continuous motion —
 * the brand's heartbeat — and it is fully suppressed under prefers-reduced-motion
 * (resolving to a static mid-day frame, handled in globals.css).
 *
 * It mirrors the app's image-forward public share surface (apps/web
 * public-surface.tsx PublicHero): a warm apricot-tint band, flat shapes, the
 * turtle — so the site and the app read as one product.
 *
 * The whole scene carries one descriptive text alternative; its decorative
 * parts are aria-hidden.
 */

import { Cloud, Hill, SeaTurtle, Sun, Village } from '~/components/illos';

export function HeroScene() {
  return (
    <div
      role="img"
      aria-label="A calm illustrated village: an apricot sun arcing slowly over a small cluster of homes on a low green hill, with a single cloud drifting and a sea turtle resting among the houses."
      className="relative w-full overflow-hidden rounded-[var(--r-xl)] panel-apricot-tint"
      style={{ aspectRatio: '4 / 3', minHeight: '20rem' }}
    >
      {/* sun — slow ambient arc */}
      <div
        className="sun-arc absolute"
        style={{ top: '16%', left: '12%', willChange: 'transform' }}
      >
        <Sun style={{ width: 'clamp(64px, 12vw, 116px)', height: 'auto' }} />
      </div>

      {/* cloud — gentle drift */}
      <div
        className="cloud-drift absolute"
        style={{ top: '12%', right: '8%', willChange: 'transform' }}
      >
        <Cloud style={{ width: 'clamp(88px, 16vw, 152px)', height: 'auto' }} />
      </div>

      {/* hill — anchored to the floor of the scene */}
      <Hill className="absolute bottom-0 left-0 w-full" style={{ height: '34%' }} />

      {/* the village — a cluster of homes on the hill */}
      <Village
        className="absolute"
        style={{ bottom: '15%', left: '7%', width: 'clamp(220px, 56vw, 420px)', height: 'auto' }}
      />

      {/* the Hale turtle, resting among the houses */}
      <SeaTurtle
        age="adult"
        className="absolute"
        style={{ bottom: '12%', right: '6%', width: 'clamp(96px, 18vw, 156px)', height: 'auto' }}
      />
    </div>
  );
}
