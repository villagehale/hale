interface DigestItemProps {
  state: 'done' | 'awaiting' | 'coach' | 'needs-you';
  timeLabel: string;
  body: string;
  undoable: boolean;
}

const STATE_LABEL: Record<DigestItemProps['state'], string> = {
  done: 'done',
  awaiting: 'awaiting',
  coach: 'coach',
  'needs-you': 'needs you',
};

const STATE_DOT_COLOR: Record<DigestItemProps['state'], string> = {
  done: 'bg-sage',
  awaiting: 'bg-terracotta',
  coach: 'bg-slate-blue',
  'needs-you': 'bg-dust-rose',
};

export function DigestItem({ state, timeLabel, body, undoable }: DigestItemProps) {
  return (
    <article className="space-y-3">
      <p className="text-lg leading-relaxed text-ink-soft">{body}</p>

      <div className="flex items-center gap-4">
        <span className="block h-px w-12 bg-hairline-strong" aria-hidden />
        <span className="smallcaps flex items-center gap-2 text-ink-quiet">
          <span
            className={`inline-block h-1.5 w-1.5 ${STATE_DOT_COLOR[state]}`}
            aria-hidden
          />
          <span>{STATE_LABEL[state]}</span>
          <span aria-hidden>·</span>
          <span>{timeLabel}</span>
        </span>

        {state === 'awaiting' ? (
          <div className="ml-auto flex gap-3 text-sm">
            <button type="button" className="smallcaps underline underline-offset-4">
              approve
            </button>
            <button type="button" className="smallcaps text-ink-quiet">
              skip
            </button>
          </div>
        ) : null}

        {undoable && state === 'done' ? (
          <button type="button" className="ml-auto smallcaps text-ink-quiet underline underline-offset-4">
            undo
          </button>
        ) : null}
      </div>
    </article>
  );
}
