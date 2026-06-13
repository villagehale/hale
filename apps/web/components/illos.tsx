/*
 * haru — "Meadow" illustration kit.
 *
 * A small bespoke set of flat, geometric, color-blocked shapes drawn from
 * circles, arcs, and soft-cornered rectangles only (corner radii ≥ 8px).
 * Two-to-three flat palette fills per illustration; no gradients, no
 * drop-shadows, no strokes thinner than 2px. The vocabulary is the daily
 * arc — sun, moon, cloud, hill, house, tree, a sleeping curve — plus the
 * trust-ladder's growing shapes (seed → sprout → sapling → tree) and the
 * haru cat in four ages.
 *
 * All shapes are ambient/compositional and decorative: each carries
 * aria-hidden so screen readers skip them; meaning lives in the copy.
 */

import type { CSSProperties } from 'react';

const C = {
  linen: 'var(--color-linen)',
  oat: 'var(--color-oat)',
  spruce: 'var(--color-spruce)',
  slate: 'var(--color-slate-green)',
  apricot: 'var(--color-apricot)',
  apricotDeep: 'var(--color-apricot-deep)',
  apricotTint: 'var(--color-apricot-tint)',
  sky: 'var(--color-sky)',
  skyDeep: 'var(--color-sky-deep)',
  skyTint: 'var(--color-sky-tint)',
  berry: 'var(--color-berry)',
} as const;

type IlloProps = { className?: string; style?: CSSProperties };

/* ── Sky bodies ────────────────────────────────────────────────────────── */

export function Sun({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 80 80" width="80" height="80" style={style} className={className} aria-hidden="true" focusable="false">
      <circle cx="40" cy="40" r="22" fill={C.apricot} />
      <circle cx="40" cy="40" r="32" fill="none" stroke={C.apricot} strokeWidth="4" strokeOpacity="0.35" />
    </svg>
  );
}

export function Moon({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 80 80" width="80" height="80" style={style} className={className} aria-hidden="true" focusable="false">
      <circle cx="40" cy="40" r="22" fill={C.oat} />
      <circle cx="50" cy="36" r="18" fill={C.spruce} />
    </svg>
  );
}

export function Crescent({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32" style={style} className={className} aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="11" fill={C.sky} />
      <circle cx="21" cy="13" r="9" fill={C.spruce} />
    </svg>
  );
}

export function Cloud({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 120 64" width="120" height="64" style={style} className={className} aria-hidden="true" focusable="false">
      <circle cx="40" cy="36" r="22" fill={C.sky} />
      <circle cx="68" cy="30" r="26" fill={C.sky} />
      <circle cx="92" cy="40" r="18" fill={C.sky} />
      <rect x="34" y="40" width="64" height="18" rx="9" fill={C.sky} />
    </svg>
  );
}

/* ── Land ──────────────────────────────────────────────────────────────── */

export function Hill({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 200 80" width="200" height="80" preserveAspectRatio="none" style={style} className={className} aria-hidden="true" focusable="false">
      <path d="M0 80 V52 Q60 16 120 36 T200 28 V80 Z" fill={C.spruce} />
    </svg>
  );
}

export function Tree({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 80 96" width="80" height="96" style={style} className={className} aria-hidden="true" focusable="false">
      <rect x="35" y="56" width="10" height="34" rx="5" fill={C.slate} />
      <circle cx="40" cy="36" r="26" fill={C.spruce} />
      <circle cx="24" cy="46" r="15" fill={C.spruce} />
      <circle cx="56" cy="46" r="15" fill={C.spruce} />
    </svg>
  );
}

export function House({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 96 96" width="96" height="96" style={style} className={className} aria-hidden="true" focusable="false">
      <rect x="20" y="44" width="56" height="44" rx="10" fill={C.oat} />
      <path d="M14 48 Q48 14 82 48 Z" fill={C.apricot} />
      <rect x="42" y="60" width="14" height="28" rx="7" fill={C.apricotDeep} />
      <rect x="28" y="56" width="12" height="12" rx="6" fill={C.skyTint} />
      <rect x="58" y="56" width="12" height="12" rx="6" fill={C.skyTint} />
    </svg>
  );
}

/* A baby's day, suggested without ever depicting a child: a soft curve
 * under a crescent — the "sleeping" motif. */
export function SleepingCurve({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 140 72" width="140" height="72" style={style} className={className} aria-hidden="true" focusable="false">
      <path d="M8 64 Q70 16 132 64 Z" fill={C.oat} />
      <rect x="8" y="58" width="124" height="10" rx="5" fill={C.slate} />
    </svg>
  );
}

/* ── Trust ladder: one organism, four ages ─────────────────────────────── */

export function Seed({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 64 64" width="64" height="64" style={style} className={className} aria-hidden="true" focusable="false">
      <rect x="14" y="48" width="36" height="10" rx="5" fill={C.oat} />
      <circle cx="32" cy="40" r="9" fill={C.apricotDeep} />
    </svg>
  );
}

export function Sprout({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 64 80" width="64" height="80" style={style} className={className} aria-hidden="true" focusable="false">
      <rect x="14" y="64" width="36" height="10" rx="5" fill={C.oat} />
      <rect x="29" y="34" width="6" height="34" rx="3" fill={C.slate} />
      <circle cx="22" cy="36" r="11" fill={C.spruce} />
      <circle cx="42" cy="30" r="11" fill={C.spruce} />
    </svg>
  );
}

export function Sapling({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 72 96" width="72" height="96" style={style} className={className} aria-hidden="true" focusable="false">
      <rect x="14" y="80" width="44" height="10" rx="5" fill={C.oat} />
      <rect x="32" y="40" width="8" height="44" rx="4" fill={C.slate} />
      <circle cx="36" cy="34" r="19" fill={C.spruce} />
      <circle cx="20" cy="44" r="11" fill={C.spruce} />
      <circle cx="52" cy="44" r="11" fill={C.spruce} />
    </svg>
  );
}

/* Tree (full-grown) reuses <Tree /> at the top of the ladder. */

/* ── The haru cat — one primitive, four ages ───────────────────────────── *
 * haru is a cat: its lifespan is roughly a childhood, which is the brand
 * thesis — it grows up alongside your kid. Drawn in the same circles/arcs/
 * soft-rect language as the rest of the kit.
 *
 * age: 'kitten' (curled asleep) | 'young' (small, sitting) |
 *      'adult' (sitting, settled) | 'senior' (poised, watchful) */

type CatAge = 'kitten' | 'young' | 'adult' | 'senior';

const CAT_BODY = C.spruce;
const CAT_EAR = C.spruce;
const CAT_NOSE = C.apricot;
const CAT_EYE = C.apricotTint;

export function Cat({ age, className, style }: IlloProps & { age: CatAge }) {
  if (age === 'kitten') {
    // a sleeping kitten: a curled-up soft mound, eyes closed (arc), tail wrapped
    return (
      <svg viewBox="0 0 120 88" width="120" height="88" style={style} className={className} aria-hidden="true" focusable="false">
        <path d="M16 78 Q16 36 60 36 Q104 36 104 78 Z" fill={CAT_BODY} />
        <rect x="14" y="70" width="92" height="14" rx="7" fill={CAT_BODY} />
        {/* tail curling round the front */}
        <path d="M104 74 Q118 70 112 56 Q108 48 98 52" fill="none" stroke={CAT_BODY} strokeWidth="11" strokeLinecap="round" />
        {/* ears */}
        <path d="M34 44 L30 26 L48 38 Z" fill={CAT_EAR} />
        <path d="M70 40 L78 24 L84 42 Z" fill={CAT_EAR} />
        {/* closed eye — a calm arc */}
        <path d="M44 58 Q52 64 60 58" fill="none" stroke={C.apricotTint} strokeWidth="3" strokeLinecap="round" />
        <circle cx="66" cy="60" r="2.6" fill={CAT_NOSE} />
      </svg>
    );
  }

  if (age === 'young') {
    // a young cat sitting upright, small and alert
    return (
      <svg viewBox="0 0 96 120" width="96" height="120" style={style} className={className} aria-hidden="true" focusable="false">
        <rect x="26" y="58" width="44" height="52" rx="22" fill={CAT_BODY} />
        <circle cx="48" cy="40" r="22" fill={CAT_BODY} />
        <path d="M30 28 L24 6 L46 22 Z" fill={CAT_EAR} />
        <path d="M66 28 L72 6 L50 22 Z" fill={CAT_EAR} />
        {/* tail flicked up */}
        <path d="M70 100 Q92 96 86 70" fill="none" stroke={CAT_BODY} strokeWidth="12" strokeLinecap="round" />
        <circle cx="40" cy="40" r="3.4" fill={CAT_EYE} />
        <circle cx="56" cy="40" r="3.4" fill={CAT_EYE} />
        <circle cx="48" cy="48" r="3" fill={CAT_NOSE} />
      </svg>
    );
  }

  if (age === 'adult') {
    // an adult cat sitting, settled, paws tucked
    return (
      <svg viewBox="0 0 120 128" width="120" height="128" style={style} className={className} aria-hidden="true" focusable="false">
        <rect x="30" y="58" width="60" height="62" rx="28" fill={CAT_BODY} />
        <rect x="32" y="106" width="56" height="16" rx="8" fill={CAT_BODY} />
        <circle cx="60" cy="42" r="28" fill={CAT_BODY} />
        <path d="M38 26 L30 0 L58 20 Z" fill={CAT_EAR} />
        <path d="M82 26 L90 0 L62 20 Z" fill={CAT_EAR} />
        <path d="M90 116 Q116 110 108 80" fill="none" stroke={CAT_BODY} strokeWidth="14" strokeLinecap="round" />
        <circle cx="50" cy="42" r="4" fill={CAT_EYE} />
        <circle cx="70" cy="42" r="4" fill={CAT_EYE} />
        <circle cx="60" cy="52" r="3.4" fill={CAT_NOSE} />
      </svg>
    );
  }

  // senior: poised, watchful — taller posture, tail wrapped neatly to the front
  return (
    <svg viewBox="0 0 120 132" width="120" height="132" style={style} className={className} aria-hidden="true" focusable="false">
      <rect x="34" y="52" width="52" height="68" rx="26" fill={CAT_BODY} />
      <rect x="30" y="108" width="64" height="16" rx="8" fill={CAT_BODY} />
      <circle cx="60" cy="38" r="26" fill={CAT_BODY} />
      <path d="M40 24 L33 0 L58 18 Z" fill={CAT_EAR} />
      <path d="M80 24 L87 0 L62 18 Z" fill={CAT_EAR} />
      {/* tail wrapped neatly across the front paws */}
      <path d="M34 118 Q60 130 86 118" fill="none" stroke={CAT_BODY} strokeWidth="13" strokeLinecap="round" />
      <circle cx="51" cy="38" r="3.6" fill={CAT_EYE} />
      <circle cx="69" cy="38" r="3.6" fill={CAT_EYE} />
      <circle cx="60" cy="47" r="3.2" fill={CAT_NOSE} />
    </svg>
  );
}

/* ── Parent-and-house — for the maker's note ───────────────────────────── */

export function ParentAndHouse({ className, style }: IlloProps) {
  return (
    <svg viewBox="0 0 160 140" width="160" height="140" style={style} className={className} aria-hidden="true" focusable="false">
      <rect x="10" y="70" width="80" height="60" rx="14" fill={C.oat} />
      <path d="M4 74 Q50 28 96 74 Z" fill={C.apricot} />
      <rect x="38" y="92" width="18" height="38" rx="9" fill={C.apricotDeep} />
      {/* a parent figure (head + soft body), holding a small bundle */}
      <circle cx="120" cy="56" r="18" fill={C.spruce} />
      <rect x="98" y="76" width="44" height="56" rx="22" fill={C.spruce} />
      <circle cx="112" cy="98" r="11" fill={C.skyTint} />
    </svg>
  );
}

/* ── Paper-grain overlay — single tileable turbulence at low opacity ────── */

export function GrainOverlay() {
  return (
    <svg className="grain" aria-hidden="true" focusable="false" preserveAspectRatio="none">
      <filter id="meadow-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#meadow-grain)" />
    </svg>
  );
}
