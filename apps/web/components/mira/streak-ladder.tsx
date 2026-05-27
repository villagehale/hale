/**
 * The trust progression ladder — visible per action class throughout
 * the product. Shows L1 ask-me → L2 draft → L3 auto-on-routine →
 * L4 scope-delegated.
 *
 * The product's commitment to user agency made tangible.
 */

export type AutonomyLevel = 1 | 2 | 3 | 4;

const LEVEL_LABEL: Record<AutonomyLevel, string> = {
  1: 'ask me',
  2: 'draft',
  3: 'auto',
  4: 'full',
};

interface StreakLadderProps {
  /** Current level for this action class. */
  level: AutonomyLevel;
  /** Optional approval streak count toward the next level. */
  streak?: number;
  /** Compact mode — used in tight cells; hides the labels. */
  compact?: boolean;
}

export function StreakLadder({ level, streak, compact = false }: StreakLadderProps) {
  const dots: AutonomyLevel[] = [1, 2, 3, 4];

  return (
    <div className={compact ? 'inline-flex items-center gap-1.5' : 'flex flex-col gap-2'}>
      <div className="flex items-center gap-1.5" aria-label={`autonomy level ${level} of 4`}>
        {dots.map((d, i) => (
          <div key={d} className="flex items-center">
            <span
              className={`block h-2 w-2 rounded-full ${
                d <= level ? 'bg-ink' : 'bg-hairline-strong'
              }`}
              aria-hidden
            />
            {i < dots.length - 1 ? (
              <span
                className={`block h-px w-3 ${
                  d < level ? 'bg-ink' : 'bg-hairline'
                }`}
                aria-hidden
              />
            ) : null}
          </div>
        ))}
      </div>

      {!compact ? (
        <div className="flex items-baseline gap-2 text-ink-mute">
          <span className="eyebrow text-ink">{LEVEL_LABEL[level]}</span>
          {streak !== undefined && level < 4 ? (
            <span className="meta tabular">
              · {streak} approvals to next
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
