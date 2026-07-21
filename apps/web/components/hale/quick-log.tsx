'use client';

import { useId, useState } from 'react';
import { Baby, Moon, Sparkles, Utensils } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Icon } from '~/components/ui/icon';
import { Modal } from '~/components/ui/modal';
import { useIsDesktop } from '~/components/hale/use-is-desktop';
import { logQuickEpisode } from '~/lib/companion/log';
import {
  DIAPER_EPISODE,
  DIAPER_KINDS,
  type DiaperKind,
  FEED_AMOUNTS,
  FEED_EPISODE,
  FEED_KINDS,
  type FeedAmount,
  type FeedKind,
  type LogResult,
  MILESTONE_EPISODE,
  NAP_EPISODE,
} from '~/lib/companion/log-types';
import {
  buildInput,
  eligibleKidsFor,
  type Kind,
  type QuickLogChild,
  visibleKindsFor,
} from './quick-log-kinds';

/** A datetime-local input takes/returns local wall-clock time with no zone. This
 * formats a Date to that shape (the form's default "when" = now). */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const FEED_KIND_LABEL: Record<FeedKind, string> = {
  bottle: 'bottle',
  breast: 'breast',
  solid: 'solid',
};

/** The qualitative "how much" chips, in the design prototype's own words. Selecting
 * one posts feedAmount instead of a millilitre figure (the two are mutually
 * exclusive). */
const FEED_AMOUNT_LABEL: Record<FeedAmount, string> = {
  little: 'a little',
  half: 'half',
  most: 'most of it',
  all: 'all of it',
};

const KIND_META: Record<
  Kind,
  { label: string; cardTitle: string; cardSubtitle: string; icon: typeof Utensils; emptyError: string }
> = {
  [FEED_EPISODE]: {
    label: 'log a feed',
    cardTitle: 'log feed',
    cardSubtitle: 'record a moment',
    icon: Utensils,
    emptyError: 'enter how much — ml, or pick how much they took',
  },
  [NAP_EPISODE]: {
    label: 'log a nap',
    cardTitle: 'log nap',
    cardSubtitle: 'track sleep',
    icon: Moon,
    emptyError: 'enter how long (minutes) before saving',
  },
  [DIAPER_EPISODE]: {
    label: 'log a diaper',
    cardTitle: 'log diaper',
    cardSubtitle: 'quick log',
    icon: Baby,
    // A diaper always has a picked kind (defaults to 'wet'), so this never fires.
    emptyError: 'pick a diaper kind before saving',
  },
  [MILESTONE_EPISODE]: {
    label: 'note a milestone',
    cardTitle: 'milestone',
    cardSubtitle: 'see progress',
    icon: Sparkles,
    emptyError: 'enter what happened before saving',
  },
};

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'logged' }
  | { kind: 'preview' }
  | { kind: 'error'; message: string };

/**
 * The quick-log row: feed / nap / milestone open an inline form that calls the
 * logQuickEpisode server action. Honest UX — saving while in flight, the error
 * surfaced in place (never a silent success), a dev-preview notice when nothing
 * is persisted. Per child: when more than one child exists, the parent picks
 * which one before logging.
 */
export function QuickLog({
  kids,
  variant = 'pills',
}: {
  kids: QuickLogChild[];
  /** 'pills' — the compact "quick log" button row (default). 'cards' — three
   * bordered action cards (icon-in-circle + title + subtitle), the Home mockup
   * layout. The form + log handlers are identical; only the triggers differ. */
  variant?: 'pills' | 'cards';
}) {
  const selectId = useId();
  const whenId = useId();
  const feedKindId = useId();
  const [open, setOpen] = useState<Kind | null>(null);
  const [childId, setChildId] = useState<string>(kids[0]?.id ?? '');
  const [amountMl, setAmountMl] = useState('');
  const [feedAmount, setFeedAmount] = useState<FeedAmount | ''>('');
  const [feedKind, setFeedKind] = useState<FeedKind | ''>('');
  const [durationMin, setDurationMin] = useState('');
  const [diaperKind, setDiaperKind] = useState<DiaperKind>('wet');
  const [diaperNote, setDiaperNote] = useState('');
  const [milestone, setMilestone] = useState('');
  const [milestoneNote, setMilestoneNote] = useState('');
  const [when, setWhen] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const isDesktop = useIsDesktop();

  if (kids.length === 0) return null;

  const visibleKinds = visibleKindsFor(kids);
  const eligibleKids = open ? eligibleKidsFor(kids, open) : kids;

  function reset() {
    setAmountMl('');
    setFeedAmount('');
    setFeedKind('');
    setDurationMin('');
    setDiaperKind('wet');
    setDiaperNote('');
    setMilestone('');
    setMilestoneNote('');
  }

  function toggle(kind: Kind) {
    setStatus({ kind: 'idle' });
    reset();
    if (open === kind) {
      setOpen(null);
      return;
    }
    const eligible = eligibleKidsFor(kids, kind);
    if (!eligible.some((c) => c.id === childId) && eligible[0]) {
      setChildId(eligible[0].id);
    }
    setWhen(toLocalInputValue(new Date()));
    setOpen(kind);
  }

  async function submit() {
    if (!open) return;
    const input = buildInput(open, childId, {
      amountMl,
      feedAmount,
      feedKind,
      durationMin,
      diaperKind,
      diaperNote,
      milestone,
      milestoneNote,
      when,
    });
    if (!input) {
      setStatus({ kind: 'error', message: KIND_META[open].emptyError });
      return;
    }
    setStatus({ kind: 'saving' });
    try {
      const result = await logQuickEpisode(input);
      applyResult(result);
    } catch {
      // A network-failed action would otherwise freeze the form on "saving…" forever
      // with the button disabled (WEB-04) — surface it so the parent can retry.
      setStatus({ kind: 'error', message: 'couldn’t save — check your connection and try again' });
    }
  }

  function applyResult(result: LogResult) {
    switch (result.status) {
      case 'logged':
        setStatus({ kind: 'logged' });
        reset();
        setOpen(null);
        break;
      case 'preview':
        setStatus({ kind: 'preview' });
        break;
      case 'forbidden':
        setStatus({ kind: 'error', message: 'that child is not in your family' });
        break;
      case 'invalid':
        setStatus({ kind: 'error', message: result.error });
        break;
    }
  }

  return (
    <div className="space-y-5">
      {variant === 'cards' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {visibleKinds.map((kind) => {
            const meta = KIND_META[kind];
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggle(kind)}
                aria-expanded={open === kind}
                className="card-interactive flex items-center gap-3 rounded-[var(--r-xl)] border border-rule bg-oat px-4 py-4 text-left shadow-[0_1px_2px_rgba(13,27,61,0.04)]"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-linen text-spruce">
                  <Icon as={meta.icon} size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-[1rem] leading-tight text-spruce">
                    {meta.cardTitle}
                  </span>
                  <span className="meta block text-slate-green">{meta.cardSubtitle}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <span className="eyebrow text-spruce mr-2">quick log</span>
          {visibleKinds.map((kind) => {
            const meta = KIND_META[kind];
            return (
              <Button
                key={kind}
                variant="secondary"
                icon={meta.icon}
                onClick={() => toggle(kind)}
                aria-expanded={open === kind}
              >
                {meta.label}
              </Button>
            );
          })}
        </div>
      )}

      {open ? (
        isDesktop ? (
          <Modal title={KIND_META[open].cardTitle} onClose={() => setOpen(null)}>
            {renderFormBody()}
          </Modal>
        ) : (
          <div className="panel-oat px-6 py-5">{renderFormBody()}</div>
        )
      ) : null}

      {status.kind === 'logged' ? (
        <output className="meta italic text-spruce block">
          logged — kept in <span data-hale-pii>{childName(kids, childId)}</span>&rsquo;s companion.
        </output>
      ) : null}
    </div>
  );

  function renderFormBody() {
    if (!open) return null;
    return (
      <div className="space-y-5">
          {eligibleKids.length > 1 ? (
            <div className="field-group">
              <label htmlFor={selectId} className="field-label">
                which child
              </label>
              <select
                id={selectId}
                className="field cursor-pointer"
                value={childId}
                onChange={(e) => setChildId(e.currentTarget.value)}
              >
                {eligibleKids.map((child) => (
                  <option key={child.id} value={child.id} data-hale-pii>
                    {child.name ?? 'your child'}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="field-group">
            <label htmlFor={whenId} className="field-label">
              when
            </label>
            <input
              id={whenId}
              type="datetime-local"
              className="field"
              value={when}
              max={toLocalInputValue(new Date())}
              onChange={(e) => setWhen(e.currentTarget.value)}
            />
            <p className="field-hint">defaults to now — change it to log something earlier</p>
          </div>

          {open === FEED_EPISODE ? (
            <>
              <Field
                label="how much (ml)"
                type="number"
                inputMode="numeric"
                min={1}
                max={2000}
                value={amountMl}
                onChange={(e) => {
                  // Typing an ml figure is the numeric path — clear any picked chip.
                  setAmountMl(e.currentTarget.value);
                  if (e.currentTarget.value) setFeedAmount('');
                }}
                placeholder="120"
              />
              <div className="field-group">
                <span className="field-label">or how much they took</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {FEED_AMOUNTS.map((amount) => {
                    const isSelected = feedAmount === amount;
                    return (
                      <button
                        key={amount}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => {
                          // Picking a chip is the qualitative path — clear the ml field.
                          setFeedAmount(isSelected ? '' : amount);
                          setAmountMl('');
                        }}
                        className={`choice-card rounded-full px-4 py-2 text-sm leading-none transition-colors ${
                          isSelected
                            ? 'bg-oat border border-spruce text-spruce'
                            : 'border border-rule-strong text-slate-green hover:border-spruce'
                        }`}
                      >
                        {FEED_AMOUNT_LABEL[amount]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="field-group">
                <label htmlFor={feedKindId} className="field-label">
                  kind (optional)
                </label>
                <select
                  id={feedKindId}
                  className="field cursor-pointer"
                  value={feedKind}
                  onChange={(e) => setFeedKind(e.currentTarget.value as FeedKind | '')}
                >
                  <option value="">not sure</option>
                  {FEED_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {FEED_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : null}

          {open === NAP_EPISODE ? (
            <Field
              label="how long (minutes)"
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              required
              value={durationMin}
              onChange={(e) => setDurationMin(e.currentTarget.value)}
              placeholder="45"
            />
          ) : null}

          {open === DIAPER_EPISODE ? (
            <>
              <div className="field-group">
                <span className="field-label">what kind</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {DIAPER_KINDS.map((kind) => {
                    const isSelected = diaperKind === kind;
                    return (
                      <button
                        key={kind}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setDiaperKind(kind)}
                        className={`choice-card rounded-full px-4 py-2 text-sm capitalize leading-none transition-colors ${
                          isSelected
                            ? 'bg-oat border border-spruce text-spruce'
                            : 'border border-rule-strong text-slate-green hover:border-spruce'
                        }`}
                      >
                        {kind}
                      </button>
                    );
                  })}
                </div>
              </div>
              <Field
                label="note (optional)"
                multiline
                maxLength={280}
                value={diaperNote}
                onChange={(e) => setDiaperNote(e.currentTarget.value)}
                placeholder="anything to remember about it"
              />
            </>
          ) : null}

          {open === MILESTONE_EPISODE ? (
            <>
              <Field
                label="what happened"
                required
                maxLength={280}
                value={milestone}
                onChange={(e) => setMilestone(e.currentTarget.value)}
                placeholder="rolled over for the first time"
              />
              <Field
                label="note (optional)"
                multiline
                maxLength={280}
                value={milestoneNote}
                onChange={(e) => setMilestoneNote(e.currentTarget.value)}
                placeholder="anything to remember about it"
              />
            </>
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={submit} disabled={status.kind === 'saving'} aria-live="polite">
              {status.kind === 'saving' ? 'saving…' : 'save log'}
            </Button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(null)}>
              cancel
            </button>
          </div>

          {status.kind === 'error' ? (
            <p className="meta italic text-berry" role="alert">
              {status.message}
            </p>
          ) : null}
          {status.kind === 'preview' ? (
            <output className="meta italic text-slate-green block">
              development preview — sign-in isn&rsquo;t configured, so this log wasn&rsquo;t saved.
            </output>
          ) : null}
      </div>
    );
  }
}

function childName(kids: QuickLogChild[], id: string): string {
  return kids.find((c) => c.id === id)?.name ?? 'your child';
}
