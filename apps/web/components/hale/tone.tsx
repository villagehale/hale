export type EntryTone = 'done' | 'awaiting' | 'coach' | 'needs-you';

const LABELS: Record<EntryTone, string> = {
  done: 'done',
  awaiting: 'awaiting you',
  coach: 'a quiet note',
  'needs-you': 'needs you',
};

const COLOR_CLASS: Record<EntryTone, string> = {
  done: 'tone-done',
  awaiting: 'tone-awaiting',
  coach: 'tone-coach',
  'needs-you': 'tone-needs-you',
};

/**
 * Each tone reads by a distinct flat-geometric glyph as well as color, so
 * the four meanings stay legible without relying on hue alone (a11y rule).
 *   done       — a filled disc (handled, settled)
 *   awaiting   — a hollow ring (open, waiting on you)
 *   coach      — a crescent (a quiet aside)
 *   needs-you  — a diamond (stop, look)
 * Drawn in the same circles/arcs/soft-rect language as the rest of the kit.
 */
function ToneGlyph({ tone }: { tone: EntryTone }) {
  const fill = `var(--color-${
    tone === 'done'
      ? 'sage'
      : tone === 'awaiting'
        ? 'apricot-deep'
        : tone === 'coach'
          ? 'sky-deep'
          : 'berry'
  })`;

  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      {tone === 'done' ? <circle cx="8" cy="8" r="6" fill={fill} /> : null}
      {tone === 'awaiting' ? (
        <circle cx="8" cy="8" r="5" fill="none" stroke={fill} strokeWidth="2.5" />
      ) : null}
      {tone === 'coach' ? (
        <>
          <circle cx="8" cy="8" r="6" fill={fill} />
          <circle cx="11" cy="6" r="5" fill="var(--color-linen)" />
        </>
      ) : null}
      {tone === 'needs-you' ? (
        <rect x="3.5" y="3.5" width="9" height="9" rx="2" transform="rotate(45 8 8)" fill={fill} />
      ) : null}
    </svg>
  );
}

interface ToneStripeProps {
  tone: EntryTone;
}

export function ToneStripe({ tone }: ToneStripeProps) {
  return <ToneGlyph tone={tone} />;
}

interface ToneLabelProps {
  tone: EntryTone;
  detail?: string;
}

/**
 * Glyph + label pairing used as the per-entry marker:
 *   ● done · 4:12 pm
 */
export function ToneLabel({ tone, detail }: ToneLabelProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <ToneGlyph tone={tone} />
      <span className={`eyebrow ${COLOR_CLASS[tone]}`}>
        {LABELS[tone]}
        {detail ? <span className="text-faded-sage"> · {detail}</span> : null}
      </span>
    </span>
  );
}
