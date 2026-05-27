interface SealProps {
  /** Tone of the seal — defaults to madder (deep red). */
  tone?: 'madder' | 'moss' | 'ink';
  /** Tagline rendered inside the ring. */
  label?: string;
  className?: string;
}

const TONE_FILL: Record<NonNullable<SealProps['tone']>, string> = {
  madder: 'var(--color-madder)',
  moss: 'var(--color-moss)',
  ink: 'var(--color-ink)',
};

/**
 * Wax-seal mark used once per page as the single visual accent.
 * SVG-rendered, scales cleanly, ink mark in the centre is the letter "m".
 */
export function Seal({ tone = 'madder', label = 'mira · toronto', className }: SealProps) {
  const fill = TONE_FILL[tone];
  return (
    <svg
      width="72"
      height="72"
      viewBox="0 0 72 72"
      role="img"
      aria-label={label}
      className={className}
    >
      <defs>
        <path
          id="seal-circle"
          d="M 36, 36 m -26, 0 a 26,26 0 1,1 52,0 a 26,26 0 1,1 -52,0"
        />
      </defs>
      <circle cx="36" cy="36" r="32" fill={fill} opacity="0.92" />
      <circle cx="36" cy="36" r="27" fill="none" stroke="var(--color-paper)" strokeWidth="0.6" />
      <text
        fontFamily="var(--font-mono)"
        fontSize="5"
        letterSpacing="2.2"
        fill="var(--color-paper)"
      >
        <textPath href="#seal-circle" startOffset="0%">
          {`${label.toUpperCase()} · ${label.toUpperCase()} ·`}
        </textPath>
      </text>
      <text
        x="36"
        y="42"
        fontFamily="var(--font-display)"
        fontSize="20"
        fontStyle="italic"
        textAnchor="middle"
        fill="var(--color-paper)"
        fontWeight="500"
      >
        m
      </text>
    </svg>
  );
}
