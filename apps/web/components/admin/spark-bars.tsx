/**
 * The pulse band's TickStrip re-parameterized: a tiny inline frequency
 * sparkline, one bar per day of the dial window, brick fill (failure
 * vocabulary — the .adm-spark rule carries it, so the dark ladder can lighten
 * it). Pure and presentational — parents slice the window and hand counts
 * oldest-first.
 */
const BAR_W = 4;
const BAR_GAP = 2;
const STRIP_H = 18;

export function SparkBars({ counts, label }: { counts: number[]; label: string }) {
  const max = Math.max(1, ...counts);
  const width = Math.max(1, counts.length * (BAR_W + BAR_GAP) - BAR_GAP);
  return (
    <svg
      viewBox={`0 0 ${width} ${STRIP_H}`}
      width="100%"
      height={STRIP_H}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
      className="adm-spark"
    >
      {counts.map((count, i) => {
        const h = count === 0 ? 1 : Math.max(3, Math.round((count / max) * STRIP_H));
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: the strip is positional by construction (one bar per window day)
            key={i}
            x={i * (BAR_W + BAR_GAP)}
            y={STRIP_H - h}
            width={BAR_W}
            height={h}
            rx={1}
            opacity={count === 0 ? 0.25 : 1}
          />
        );
      })}
    </svg>
  );
}
