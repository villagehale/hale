interface EntryMarkProps {
  /** Visual semantic state of the entry that follows this mark. */
  tone: 'done' | 'awaiting' | 'coach' | 'needs-you';
  /** Right-side label: a time, "approve or skip", "a quiet note", etc. */
  detail: string;
}

const TONE_LABEL: Record<EntryMarkProps['tone'], string> = {
  done: 'done',
  awaiting: 'awaiting',
  coach: 'a quiet note',
  'needs-you': 'needs you',
};

const TONE_DOT_COLOR: Record<EntryMarkProps['tone'], string> = {
  done: 'var(--color-moss)',
  awaiting: 'var(--color-madder)',
  coach: 'var(--color-slate-quiet)',
  'needs-you': 'var(--color-madder)',
};

/**
 * The "━━━ done · 4:12 pm ━━━" marker that anchors each digest entry.
 * Hairline rules on either side of an inline mono label with a 6px
 * coloured dot encoding the entry tone.
 */
export function EntryMark({ tone, detail }: EntryMarkProps) {
  return (
    <div className="entry-mark">
      <span
        aria-hidden
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: TONE_DOT_COLOR[tone],
          flexShrink: 0,
          marginRight: '-0.25rem',
        }}
      />
      <span>{TONE_LABEL[tone]}</span>
      <span aria-hidden>·</span>
      <span>{detail}</span>
    </div>
  );
}
