/*
 * The hero's "one calm day" scene: a low Spruce hill, a small Oat house,
 * an Apricot sun on a slow 30s ambient arc, a Sky cloud drifting, and a
 * sleeping kitten (the youngest haru) curled beside the house. The sun's
 * arc is the only continuous motion — the brand's heartbeat — and it is
 * fully suppressed under prefers-reduced-motion (resolving to a static
 * mid-day frame, handled in globals.css).
 *
 * The whole scene carries one descriptive text alternative; its decorative
 * parts are aria-hidden.
 */

import { Cat, Cloud, Hill, House, Sun } from '~/components/illos';

export function HeroScene() {
  return (
    <div
      role="img"
      aria-label="A calm illustrated day: an apricot sun arcing slowly over a small house on a low green hill, with a single cloud drifting and a kitten asleep beside the door."
      className="relative w-full overflow-hidden rounded-[var(--r-xl)] panel-sky-tint"
      style={{ aspectRatio: '4 / 3', minHeight: '20rem' }}
    >
      {/* sun — slow ambient arc */}
      <div
        className="sun-arc absolute"
        style={{ top: '18%', left: '14%', willChange: 'transform' }}
      >
        <Sun style={{ width: 'clamp(72px, 14vw, 132px)', height: 'auto' }} />
      </div>

      {/* cloud — gentle drift */}
      <div
        className="cloud-drift absolute"
        style={{ top: '12%', right: '10%', willChange: 'transform' }}
      >
        <Cloud style={{ width: 'clamp(96px, 18vw, 168px)', height: 'auto' }} />
      </div>

      {/* hill — anchored to the floor of the scene */}
      <Hill
        className="absolute bottom-0 left-0 w-full"
        style={{ height: '38%' }}
      />

      {/* house — sits on the hill */}
      <House
        className="absolute"
        style={{ bottom: '20%', left: '18%', width: 'clamp(88px, 16vw, 136px)', height: 'auto' }}
      />

      {/* the youngest haru, asleep by the door */}
      <Cat
        age="kitten"
        className="absolute"
        style={{ bottom: '17%', left: '40%', width: 'clamp(84px, 15vw, 132px)', height: 'auto' }}
      />
    </div>
  );
}
