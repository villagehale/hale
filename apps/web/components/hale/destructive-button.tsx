'use client';

import { useState } from 'react';

/**
 * A two-tap confirm button: the first tap arms it (swapping to the confirm
 * label), the second would fire. Blurring disarms it. The action itself isn't
 * wired yet — the guard is the reusable bit.
 */
export function DestructiveButton({
  label,
  confirmLabel,
  className,
}: {
  label: string;
  confirmLabel: string;
  className: string;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => setArmed((v) => !v)}
      onBlur={() => setArmed(false)}
      aria-pressed={armed}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
