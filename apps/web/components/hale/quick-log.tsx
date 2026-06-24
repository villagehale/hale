'use client';

import { useId, useState } from 'react';
import { Moon, Sparkles, Utensils } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { logQuickEpisode } from '~/lib/companion/log';
import {
  FEED_EPISODE,
  type LogResult,
  MILESTONE_EPISODE,
  NAP_EPISODE,
  type QuickLogInput,
} from '~/lib/companion/log-types';
import {
  eligibleKidsFor,
  type Kind,
  type QuickLogChild,
  visibleKindsFor,
} from './quick-log-kinds';

const KIND_META: Record<Kind, { label: string; icon: typeof Utensils; emptyError: string }> = {
  [FEED_EPISODE]: {
    label: 'log a feed',
    icon: Utensils,
    emptyError: 'enter how much (ml) before saving',
  },
  [NAP_EPISODE]: {
    label: 'log a nap',
    icon: Moon,
    emptyError: 'enter how long (minutes) before saving',
  },
  [MILESTONE_EPISODE]: {
    label: 'note a milestone',
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
export function QuickLog({ kids }: { kids: QuickLogChild[] }) {
  const selectId = useId();
  const [open, setOpen] = useState<Kind | null>(null);
  const [childId, setChildId] = useState<string>(kids[0]?.id ?? '');
  const [amountMl, setAmountMl] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [milestone, setMilestone] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  if (kids.length === 0) return null;

  const visibleKinds = visibleKindsFor(kids);
  const eligibleKids = open ? eligibleKidsFor(kids, open) : kids;

  function reset() {
    setAmountMl('');
    setDurationMin('');
    setMilestone('');
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
    setOpen(kind);
  }

  async function submit() {
    if (!open) return;
    const input = buildInput(open, childId, { amountMl, durationMin, milestone });
    if (!input) {
      setStatus({ kind: 'error', message: KIND_META[open].emptyError });
      return;
    }
    setStatus({ kind: 'saving' });
    const result = await logQuickEpisode(input);
    applyResult(result);
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

      {open ? (
        <div className="panel-oat px-6 py-5 space-y-5">
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
                  <option key={child.id} value={child.id}>
                    {child.name ?? 'your child'}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {open === FEED_EPISODE ? (
            <Field
              label="how much (ml)"
              type="number"
              inputMode="numeric"
              min={1}
              max={2000}
              required
              value={amountMl}
              onChange={(e) => setAmountMl(e.currentTarget.value)}
              placeholder="120"
            />
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

          {open === MILESTONE_EPISODE ? (
            <Field
              label="what happened"
              required
              maxLength={280}
              value={milestone}
              onChange={(e) => setMilestone(e.currentTarget.value)}
              placeholder="rolled over for the first time"
            />
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
            <p className="meta italic text-apricot-deep" role="alert">
              {status.message}
            </p>
          ) : null}
          {status.kind === 'preview' ? (
            <output className="meta italic text-slate-green block">
              development preview — sign-in isn&rsquo;t configured, so this log wasn&rsquo;t saved.
            </output>
          ) : null}
        </div>
      ) : null}

      {status.kind === 'logged' ? (
        <output className="meta italic text-spruce block">
          logged — kept in {childName(kids, childId)}&rsquo;s companion.
        </output>
      ) : null}
    </div>
  );
}

function childName(kids: QuickLogChild[], id: string): string {
  return kids.find((c) => c.id === id)?.name ?? 'your child';
}

/**
 * Builds the typed server-action input for the open form, or null when the
 * required field is empty / non-numeric. Numeric coercion + bounds are enforced
 * server-side too (zod); this is the client-side guard so we never POST a blank.
 */
function buildInput(
  kind: Kind,
  childId: string,
  values: { amountMl: string; durationMin: string; milestone: string },
): QuickLogInput | null {
  if (!childId) return null;
  switch (kind) {
    case FEED_EPISODE: {
      const amountMl = Number(values.amountMl);
      if (!values.amountMl || Number.isNaN(amountMl)) return null;
      return { kind: FEED_EPISODE, childId, amountMl };
    }
    case NAP_EPISODE: {
      const durationMin = Number(values.durationMin);
      if (!values.durationMin || Number.isNaN(durationMin)) return null;
      return { kind: NAP_EPISODE, childId, durationMin };
    }
    case MILESTONE_EPISODE: {
      const milestone = values.milestone.trim();
      if (!milestone) return null;
      return { kind: MILESTONE_EPISODE, childId, milestone };
    }
  }
}
