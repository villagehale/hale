'use client';

import { useState } from 'react';

export interface AvatarProps {
  /** Image URL — the parent's Google profile photo, or an uploaded child photo's
   * signed URL. Null/absent → the initials disc. Falls back to initials on load
   * error too, so a dead URL never shows a broken image. */
  src?: string | null;
  /** Pre-formatted initials for the fallback disc: "BD" (parent) or "S" (a child).
   * The caller owns the format (the child single-initial vs parent two-initial rule
   * lives at the call sites, not here). */
  initials: string;
  /** 'account' = navy disc + on-navy initials (the signed-in parent); 'child' = warm
   * disc + navy initials (a child). The two tones keep the account chip and child
   * chip from reading as the same name row (design handoff §3.1). */
  tone: 'account' | 'child';
  /** Square disc size in px (both chips use 32; the companion header uses larger). */
  size?: number;
  className?: string;
}

/**
 * The one people-avatar treatment across the app: a photo when we have one, else a
 * tinted initials disc. Decorative by default (aria-hidden) — every call site shows
 * the person's name in adjacent text, so the disc carries no independent label.
 *
 * The upload lane wires a child's signed avatar URL into `src`; until then children
 * render initials. The parent's Google photo comes from the session (`user.image`).
 */
export function Avatar({ src, initials, tone, size = 32, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const cls = `avatar avatar-${tone}${className ? ` ${className}` : ''}`;

  if (src && !failed) {
    return (
      // biome-ignore lint/a11y/useAltText: decorative — the name is in adjacent text; alt="" + aria-hidden keeps the disc out of the a11y tree
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        // googleusercontent photos 403 when a referrer is sent — request none.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`${cls} avatar-image`}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className={cls}
      // Size the initials to the disc (≈40%) so the same primitive reads well at both
      // the 32px chips and the larger companion header.
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
