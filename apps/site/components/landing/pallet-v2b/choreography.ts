/**
 * The scroll choreography, as pure data + pure functions.
 *
 * Four keyframes drive the whole deck, sampled at scroll progress
 * `[0, 0.33, 0.66, 1]` across the pinned track:
 *
 *   FAN      seven cards spread across the hero, the centre one upright
 *   STACK    every card converges on one place — the page's whole argument,
 *            which the caption then says out loud
 *   DESCEND  the single stack drops toward the second section
 *   CASCADE  it re-fans into the diagonal ladder beside that section's copy
 *
 * Kept as data so the mobile simplification is a different TABLE, not a
 * different code path: same four beats, same interpolation, smaller geometry.
 */

export type CardPose = { x: number; y: number; rotate: number; scale: number };

/** The four poses a single card passes through, in order. */
export type CardTrack = readonly [CardPose, CardPose, CardPose, CardPose];

/** Where each keyframe sits on the 0-1 track. */
export const STOPS = [0, 0.33, 0.66, 1] as const;

export type Layout = 'mobile' | 'tablet' | 'desktop';

/** The template's seven-slot fan, verbatim. */
const FAN_X = [-480, -310, -155, 0, 160, 320, 480] as const;
const FAN_Y = [18, 6, -2, -8, -2, 6, 18] as const;
const FAN_ROTATE = [-18, -10, -4, 0, 5, 12, 20] as const;
const FAN_SCALE = [0.88, 0.92, 0.96, 1, 0.96, 0.92, 0.88] as const;

/**
 * Mobile has no room for a ±480px fan, so the seven cards start as a *peek
 * stack* — a shuffled pile, every card visible at its corner. It keeps the
 * gather beat intact (a pile becoming one thing is the same story a spread
 * becoming one thing tells) at a geometry that fits a 320px viewport, which a
 * swipe carousel could not: a carousel has no scroll-linked convergence.
 */
const PEEK_X = [-42, -28, -14, 0, 14, 28, 42] as const;
const PEEK_Y = [26, 18, 10, 0, 10, 18, 26] as const;
const PEEK_ROTATE = [-9, -6, -3, 0, 3, 6, 9] as const;
const PEEK_SCALE = [0.86, 0.9, 0.94, 1, 0.94, 0.9, 0.86] as const;

/** Per-layout constants: fan spread, where the deck sits, and the ladder. */
const GEOMETRY = {
  desktop: {
    fanScale: 1,
    fanOffsetY: 200,
    stack: { y: 40, scale: 1.02 },
    descend: { y: 200, scale: 0.9 },
    cascade: { x0: 30, dx: 92, y0: -230, dy: 76, rotate0: -3, dRotate: 3, scale: 0.84 },
  },
  tablet: {
    fanScale: 0.62,
    fanOffsetY: 190,
    stack: { y: 36, scale: 1.02 },
    descend: { y: 180, scale: 0.9 },
    cascade: { x0: 8, dx: 62, y0: -206, dy: 68, rotate0: -3, dRotate: 3, scale: 0.8 },
  },
  mobile: {
    fanScale: 1,
    fanOffsetY: 210,
    stack: { y: 40, scale: 1 },
    descend: { y: 150, scale: 0.95 },
    /** Vertical ladder: the diagonal becomes a slight left-right sway. */
    cascade: { x0: -13, dx: 4.4, y0: -186, dy: 74, rotate0: -2.4, dRotate: 0.8, scale: 0.82 },
  },
} as const;

/** The four poses for one slot under one layout. */
export function trackForSlot(slot: number, layout: Layout): CardTrack {
  const g = GEOMETRY[layout];
  const mobile = layout === 'mobile';
  const xs = mobile ? PEEK_X : FAN_X;
  const ys = mobile ? PEEK_Y : FAN_Y;
  const rotates = mobile ? PEEK_ROTATE : FAN_ROTATE;
  const scales = mobile ? PEEK_SCALE : FAN_SCALE;

  const fan: CardPose = {
    x: (xs[slot] ?? 0) * g.fanScale,
    y: (ys[slot] ?? 0) + g.fanOffsetY,
    rotate: rotates[slot] ?? 0,
    scale: scales[slot] ?? 1,
  };
  const stack: CardPose = { x: 0, y: g.stack.y, rotate: 0, scale: g.stack.scale };
  const descend: CardPose = { x: 0, y: g.descend.y, rotate: 0, scale: g.descend.scale };
  const c = g.cascade;
  const cascade: CardPose = {
    x: c.x0 + slot * c.dx,
    y: c.y0 + slot * c.dy,
    rotate: c.rotate0 + slot * c.dRotate,
    scale: c.scale,
  };
  return [fan, stack, descend, cascade];
}

/** Progress within `[from, to]`, clamped to 0-1. Zero-width ranges read as 1. */
export function ramp(p: number, from: number, to: number): number {
  if (to <= from) return p >= to ? 1 : 0;
  return Math.min(1, Math.max(0, (p - from) / (to - from)));
}

/** Piecewise-linear sample of a four-pose track at scroll progress `p`. */
export function poseAt(track: CardTrack, p: number): CardPose {
  let i = 0;
  while (i < STOPS.length - 2 && p > (STOPS[i + 1] as number)) i += 1;
  const a = track[i] as CardPose;
  const b = track[i + 1] as CardPose;
  const t = ramp(p, STOPS[i] as number, STOPS[i + 1] as number);
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    rotate: a.rotate + (b.rotate - a.rotate) * t,
    scale: a.scale + (b.scale - a.scale) * t,
  };
}

/** The transform string written to a card each frame. Transform + opacity only. */
export function transformFor(pose: CardPose): string {
  return `translate(-50%, -50%) translate3d(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px, 0) rotate(${pose.rotate.toFixed(2)}deg) scale(${pose.scale.toFixed(4)})`;
}

/**
 * Intro entrance — the lead card in three phases, the rest revealed in its wake.
 *
 *   0 → 720ms      rise      the lead card lifts into the centre
 *   720 → 1320ms   fly right the lead card runs out to the right edge of the fan
 *   1320 → 2920ms  sweep     it sweeps back left into its slot, and every card it
 *                            passes appears behind it
 *
 * The sweep runs on smoothEase `cubic-bezier(0.22, 1, 0.36, 1)`, so a card's
 * reveal time is that curve *inverted* at the card's own position — the eased
 * motion is fast out and slow in, so the reveals bunch on the right and open out
 * to the left. Solved numerically once and baked here (slot 0 first in the
 * array, slot 6 last); the inversion is taken over a travel that runs a little
 * past the leftmost slot, which stops the curve's flat tail from stranding the
 * last card almost a second behind its neighbour.
 */
export const REVEAL_DELAY_MS = [2240, 1925, 1752, 1618, 1505, 1407, 1320] as const;

export const LEAD_ENTRANCE_MS = 2920;

/** How far right the lead card runs in phase two, per layout. */
const FLY_X: Record<Layout, number> = { desktop: 480, tablet: 298, mobile: 120 };

/** The breakpoints the layouts are cut on — the same ones `readLayout` reads. */
const LAYOUT_QUERY: Record<Layout, string | null> = {
  desktop: null,
  tablet: '(max-width: 1199px)',
  mobile: '(max-width: 767px)',
};

function fanRules(slots: number, layout: Layout): string {
  const rows: string[] = [`[data-v2b="deck"]{--v2b-fly-x:${FLY_X[layout]}px}`];
  for (let slot = 0; slot < slots; slot += 1) {
    const fan = trackForSlot(slot, layout)[0];
    rows.push(
      `[data-v2b="card"][data-slot="${slot}"]{--fx:${fan.x}px;--fy:${fan.y}px;--fr:${fan.rotate}deg;--fs:${fan.scale}}`,
    );
  }
  return rows.join('');
}

/**
 * The fan pose as a real stylesheet, generated from the same tables the
 * choreography interpolates — so the first painted frame is the fan at the right
 * size for the viewport, before any JavaScript runs, with no second source of
 * truth to drift. Emitted inline by the page; wrapped in `@layer components` so
 * it cannot outrank a utility.
 */
export function fanStyleSheet(slots: number): string {
  const blocks = [fanRules(slots, 'desktop')];
  for (const layout of ['tablet', 'mobile'] as const) {
    blocks.push(`@media ${LAYOUT_QUERY[layout]}{${fanRules(slots, layout)}}`);
  }
  const delays = REVEAL_DELAY_MS.slice(0, slots)
    .map((ms, slot) => `[data-v2b="card"][data-slot="${slot}"]{--v2b-reveal-delay:${ms}ms}`)
    .join('');
  return `@layer components{${blocks.join('')}${delays}}`;
}
