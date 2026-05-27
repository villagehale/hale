/**
 * Per-action trust ladder — L1 ask-me → L2 draft → L3 auto-on-routine →
 * L4 scope-delegated. Drawn as four notches on a rule, so it reads like
 * a printer's measure rather than a generic progress bar.
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
  const notches: AutonomyLevel[] = [1, 2, 3, 4];

  return (
    <div className={compact ? 'inline-flex items-center gap-1.5' : 'flex flex-col gap-2.5'}>
      <div
        className="flex items-center gap-1.5"
        aria-label={`autonomy level ${level} of 4`}
      >
        {notches.map((n, i) => (
          <div key={n} className="flex items-center">
            <span
              className="block h-3 w-px"
              style={{ background: n <= level ? 'var(--color-iron)' : 'var(--color-rule-strong)' }}
              aria-hidden
            />
            {i < notches.length - 1 ? (
              <span
                className="block h-px w-5"
                style={{ background: n < level ? 'var(--color-iron)' : 'var(--color-rule)' }}
                aria-hidden
              />
            ) : null}
          </div>
        ))}
        <span className="meta tabular ml-1.5 text-iron">
          {LEVEL_LABEL[level]}
        </span>
      </div>

      {!compact && streak !== undefined && level < 4 ? (
        <div className="text-faded">
          <span className="meta tabular">
            {Math.min(streak, 5)} of 5 approvals
            {streak < 5 ? <> · {5 - streak} to next</> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
