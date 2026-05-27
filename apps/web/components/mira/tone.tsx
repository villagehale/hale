export type EntryTone = 'done' | 'awaiting' | 'coach' | 'needs-you';

const LABELS: Record<EntryTone, string> = {
  done: 'done',
  awaiting: 'awaiting',
  coach: 'a quiet note',
  'needs-you': 'needs you',
};

interface ToneStripeProps {
  tone: EntryTone;
}

export function ToneStripe({ tone }: ToneStripeProps) {
  return <span className="tone-stripe" data-tone={tone} aria-hidden />;
}

interface ToneLabelProps {
  tone: EntryTone;
  detail?: string;
}

/**
 * Stripe + label pairing used as the per-entry marker:
 *   ──── done · 4:12 pm
 */
export function ToneLabel({ tone, detail }: ToneLabelProps) {
  return (
    <span className="inline-flex items-center gap-3">
      <ToneStripe tone={tone} />
      <span className="eyebrow text-ink-soft">
        {LABELS[tone]}
        {detail ? <span className="text-ink-mute"> · {detail}</span> : null}
      </span>
    </span>
  );
}
