/*
 * Hale — "Meadow" illustration kit.
 *
 * A small bespoke set of flat, geometric, color-blocked shapes drawn from
 * circles, arcs, and soft-cornered rectangles only (corner radii ≥ 8px).
 * Two-to-three flat palette fills per illustration; no gradients, no
 * drop-shadows, no strokes thinner than 2px. The vocabulary is the daily
 * arc — sun, moon, cloud, hill, house, tree, a sleeping curve — plus the
 * trust-ladder's growing shapes (seed → sprout → sapling → tree) and the
 * Hale sea turtle in four ages.
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

/* ── The Hale sea turtle — one primitive, four ages ────────────────────── *
 * Hale is a sea turtle: it grows slowly and steadily across a long life,
 * which is the brand thesis — it grows up alongside your kid, newborn to
 * teenager. Drawn in the same circles/arcs/soft-rect language as the rest
 * of the kit, but in PROFILE so the silhouette reads unmistakably as a
 * turtle: a domed shell (arc + base rect) with two or three rounded scute
 * divisions, a head on a short neck reaching FORWARD out of the shell, a
 * front flipper and a hint of a back flipper along the ground, and a small
 * tail — all resting on a soft ground line. Calm sea-green built from the
 * sky/spruce palette, with apricot used only as a tiny eye accent.
 *
 * The turtle faces right; the profile is identical across ages, growing
 * from small to large.
 *
 * age: 'hatchling' (tiny, just-emerged) | 'young' (small, walking) |
 *      'adult' (settled, broad shell)  | 'elder' (largest, serene) */

type TurtleAge = 'hatchling' | 'young' | 'adult' | 'elder';

const TURTLE_SHELL = C.skyDeep;
const TURTLE_LIMB = C.sky;
const TURTLE_SCUTE = C.skyTint;
const TURTLE_HEAD = C.spruce;
const TURTLE_EYE = C.apricot;
const TURTLE_GROUND = C.oat;

export function SeaTurtle({ age, className, style }: IlloProps & { age: TurtleAge }) {
  if (age === 'hatchling') {
    // a tiny hatchling in profile: small domed shell, head reaching forward
    return (
      <svg viewBox="0 0 104 76" width="104" height="76" style={style} className={className} aria-hidden="true" focusable="false">
        {/* ground line */}
        <rect x="8" y="62" width="76" height="8" rx="4" fill={TURTLE_GROUND} />
        {/* tail at the back, flippers along the ground */}
        <rect x="16" y="50" width="11" height="8" rx="4" fill={TURTLE_LIMB} />
        <rect x="28" y="54" width="15" height="10" rx="5" fill={TURTLE_LIMB} />
        <rect x="54" y="54" width="17" height="10" rx="5" fill={TURTLE_LIMB} />
        {/* domed shell — half-disc arc plus a soft base */}
        <path d="M24 56 Q24 30 50 30 Q76 30 76 56 Z" fill={TURTLE_SHELL} />
        <rect x="24" y="50" width="52" height="9" rx="4.5" fill={TURTLE_SHELL} />
        {/* two soft scute divisions */}
        <rect x="38" y="36" width="13" height="18" rx="6" fill={TURTLE_SCUTE} />
        <rect x="55" y="40" width="13" height="14" rx="6" fill={TURTLE_SCUTE} />
        {/* neck + head reaching forward */}
        <rect x="72" y="40" width="16" height="11" rx="5.5" fill={TURTLE_HEAD} />
        <circle cx="88" cy="42" r="9" fill={TURTLE_HEAD} />
        <circle cx="91" cy="40" r="2.2" fill={TURTLE_EYE} />
      </svg>
    );
  }

  if (age === 'young') {
    // a young turtle in profile, walking: a rounder shell, a longer neck
    return (
      <svg viewBox="0 0 128 92" width="128" height="92" style={style} className={className} aria-hidden="true" focusable="false">
        {/* ground line */}
        <rect x="10" y="76" width="92" height="9" rx="4.5" fill={TURTLE_GROUND} />
        {/* tail at the back, flippers along the ground */}
        <rect x="20" y="60" width="13" height="10" rx="5" fill={TURTLE_LIMB} />
        <rect x="34" y="64" width="19" height="13" rx="6.5" fill={TURTLE_LIMB} transform="rotate(-12 43.5 70.5)" />
        <rect x="66" y="64" width="21" height="13" rx="6.5" fill={TURTLE_LIMB} transform="rotate(10 76.5 70.5)" />
        {/* domed shell */}
        <path d="M28 66 Q28 32 60 32 Q92 32 92 66 Z" fill={TURTLE_SHELL} />
        <rect x="28" y="58" width="64" height="11" rx="5.5" fill={TURTLE_SHELL} />
        {/* three soft scute divisions following the dome */}
        <rect x="42" y="38" width="14" height="22" rx="6.5" fill={TURTLE_SCUTE} />
        <rect x="58" y="40" width="14" height="20" rx="6.5" fill={TURTLE_SCUTE} />
        <rect x="74" y="46" width="13" height="14" rx="6" fill={TURTLE_SCUTE} />
        {/* neck + head reaching forward */}
        <rect x="88" y="44" width="19" height="13" rx="6.5" fill={TURTLE_HEAD} />
        <circle cx="107" cy="46" r="11" fill={TURTLE_HEAD} />
        <circle cx="111" cy="43" r="2.6" fill={TURTLE_EYE} />
      </svg>
    );
  }

  if (age === 'adult') {
    // an adult turtle in profile, settled: a broad domed shell, full scutes
    return (
      <svg viewBox="0 0 152 104" width="152" height="104" style={style} className={className} aria-hidden="true" focusable="false">
        {/* ground line */}
        <rect x="12" y="86" width="110" height="10" rx="5" fill={TURTLE_GROUND} />
        {/* tail at the back, flippers along the ground */}
        <rect x="22" y="68" width="15" height="12" rx="6" fill={TURTLE_LIMB} />
        <rect x="38" y="72" width="23" height="15" rx="7.5" fill={TURTLE_LIMB} transform="rotate(-12 49.5 79.5)" />
        <rect x="78" y="72" width="25" height="15" rx="7.5" fill={TURTLE_LIMB} transform="rotate(10 90.5 79.5)" />
        {/* domed shell */}
        <path d="M32 74 Q32 34 70 34 Q108 34 108 74 Z" fill={TURTLE_SHELL} />
        <rect x="32" y="64" width="76" height="13" rx="6.5" fill={TURTLE_SHELL} />
        {/* three soft scute divisions following the dome */}
        <rect x="48" y="40" width="16" height="26" rx="7.5" fill={TURTLE_SCUTE} />
        <rect x="66" y="42" width="16" height="24" rx="7.5" fill={TURTLE_SCUTE} />
        <rect x="84" y="50" width="15" height="16" rx="7" fill={TURTLE_SCUTE} />
        {/* neck + head reaching forward */}
        <rect x="104" y="48" width="22" height="15" rx="7.5" fill={TURTLE_HEAD} />
        <circle cx="126" cy="50" r="13" fill={TURTLE_HEAD} />
        <circle cx="131" cy="47" r="3" fill={TURTLE_EYE} />
      </svg>
    );
  }

  // elder: the largest, most serene — a tall, broad shell in the same profile
  return (
    <svg viewBox="0 0 168 112" width="168" height="112" style={style} className={className} aria-hidden="true" focusable="false">
      {/* ground line */}
      <rect x="12" y="94" width="124" height="11" rx="5.5" fill={TURTLE_GROUND} />
      {/* tail at the back, flippers along the ground */}
      <rect x="24" y="74" width="16" height="13" rx="6.5" fill={TURTLE_LIMB} />
      <rect x="42" y="78" width="25" height="16" rx="8" fill={TURTLE_LIMB} transform="rotate(-12 54.5 86)" />
      <rect x="86" y="78" width="27" height="16" rx="8" fill={TURTLE_LIMB} transform="rotate(10 99.5 86)" />
      {/* domed shell — tallest of the four */}
      <path d="M34 80 Q34 36 76 36 Q118 36 118 80 Z" fill={TURTLE_SHELL} />
      <rect x="34" y="70" width="84" height="14" rx="7" fill={TURTLE_SHELL} />
      {/* three soft scute divisions following the dome */}
      <rect x="52" y="42" width="17" height="28" rx="8" fill={TURTLE_SCUTE} />
      <rect x="71" y="44" width="17" height="26" rx="8" fill={TURTLE_SCUTE} />
      <rect x="90" y="52" width="16" height="18" rx="7.5" fill={TURTLE_SCUTE} />
      {/* neck + head reaching forward */}
      <rect x="114" y="50" width="24" height="16" rx="8" fill={TURTLE_HEAD} />
      <circle cx="138" cy="52" r="14" fill={TURTLE_HEAD} />
      <circle cx="143" cy="49" r="3.2" fill={TURTLE_EYE} />
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
