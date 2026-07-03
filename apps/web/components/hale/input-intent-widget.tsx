'use client';

import { useId, useState } from 'react';
import { Field } from '~/components/ui/field';
import { ChildScope, type ScopeChild } from '~/components/hale/child-scope';
import type { InputIntent, PlanLogParse, QuickLogParse } from '~/components/hale/use-ask-hale';
import { logQuickEpisode } from '~/lib/companion/log';
import {
  FEED_EPISODE,
  type LogResult,
  MILESTONE_EPISODE,
  NAP_EPISODE,
  type QuickLogInput,
} from '~/lib/companion/log-types';
import type { TimelineChild } from '~/lib/coach/thread';
import { createPlan } from '~/lib/plan/plan-actions';

/**
 * The input-side command widgets — the parent's OWN instruction, detected on send
 * (detectInputIntents, regex-only), surfaced as a rich confirm CARD under the user
 * turn. Two categories, routed differently:
 *
 *  - 'action' (book/remind/find): a confirm card that routes through the EXISTING
 *    approval engine (POST /api/coach/action → draftInlineAction). Held for
 *    approval — Hale never auto-acts (rule #4). Success copy is honest: "added to
 *    your approvals".
 *  - 'log' (quick_log): the parent's OWN household data — no approval gate. A
 *    pre-filled, EDITABLE card that calls the EXISTING logQuickEpisode server
 *    action (reuse — one write path, one audit row, rule #6; family-scoped, rule
 *    #1). On success it confirms and dismisses.
 *
 * Meadow-styled with existing tokens only: an oat inset card (--r-lg), tone by
 * label + shape (never a color stripe), real buttons with visible focus, and
 * aria-live state announcements. No emoji.
 */

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toOccurredAt(when: string): string | undefined {
  if (!when) return undefined;
  const date = new Date(when);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function InputIntentWidgets({
  intents,
  focusedChildId,
  question,
  kids,
}: {
  intents: InputIntent[];
  focusedChildId: string | null;
  question: string;
  kids: TimelineChild[];
}) {
  return (
    <div className="mt-3 space-y-3">
      {intents.map((intent) => {
        if (intent.category === 'action') {
          return (
            <ActionConfirmCard
              key={intent.kind}
              intent={intent}
              focusedChildId={focusedChildId}
              question={question}
            />
          );
        }
        if (intent.category === 'plan') {
          return (
            <CreatePlanCard
              key={intent.kind}
              parsed={intent.parsed}
              focusedChildId={focusedChildId}
              kids={kids}
            />
          );
        }
        return (
          <QuickLogCard
            key={intent.kind}
            parsed={intent.parsed}
            focusedChildId={focusedChildId}
            kids={kids}
          />
        );
      })}
    </div>
  );
}

type ActionState = 'idle' | 'pending' | 'drafted' | 'dismissed' | 'error';

const ACTION_SUMMARY: Record<string, string> = {
  book_checkup: 'Draft a calendar event to book a check-up, held for your approval.',
  set_reminder: 'Draft a reminder, held for your approval.',
  find_activities: 'Find local activities and add them to your digest, held for your approval.',
};

function ActionConfirmCard({
  intent,
  focusedChildId,
  question,
}: {
  intent: Extract<InputIntent, { category: 'action' }>;
  focusedChildId: string | null;
  question: string;
}) {
  const headingId = useId();
  const [state, setState] = useState<ActionState>('idle');

  async function confirm() {
    if (state === 'pending' || state === 'drafted') return;
    setState('pending');
    try {
      const res = await fetch('/api/coach/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intentKind: intent.kind,
          ...(focusedChildId ? { focusedChildId } : {}),
          sourceAnswer: question,
        }),
      });
      setState(res.ok ? 'drafted' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'dismissed') return null;

  return (
    <section
      aria-labelledby={headingId}
      className="panel-oat px-5 py-4 space-y-3 max-w-prose"
    >
      <p id={headingId} className="field-label">
        {intent.label}
      </p>
      <p className="meta">{ACTION_SUMMARY[intent.kind]}</p>
      <output className="meta italic text-slate-green block" aria-live="polite">
        {state === 'drafted'
          ? 'added to your approvals'
          : state === 'error'
            ? 'couldn’t draft — try again'
            : ''}
      </output>
      {state !== 'drafted' ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={confirm}
            disabled={state === 'pending'}
          >
            {state === 'pending' ? 'drafting…' : 'Confirm'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setState('dismissed')}>
            Not now
          </button>
        </div>
      ) : null}
    </section>
  );
}

type LogEpisode = QuickLogParse['episode'];

const EPISODE_LABEL: Record<LogEpisode, string> = {
  feed: 'Log a feed',
  nap: 'Log a nap',
  milestone: 'Note a milestone',
};

const EMPTY_ERROR: Record<LogEpisode, string> = {
  feed: 'enter how much (ml) before saving',
  nap: 'enter how long (minutes) before saving',
  milestone: 'enter what happened before saving',
};

type LogState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'logged' }
  | { kind: 'preview' }
  | { kind: 'dismissed' }
  | { kind: 'error'; message: string };

/** Match the parsed child name to a family child (label is null for a teen, so a
 * name match can only land on a non-teen — a teen quick_log falls back to the
 * focused child or the parent's pick). Family-scoped by construction: only
 * seed.children (this family's kids) are options. */
function preselectChild(
  kids: TimelineChild[],
  focusedChildId: string | null,
  childName: string | undefined,
): string {
  if (childName) {
    const byName = kids.find((c) => c.label?.toLowerCase() === childName.toLowerCase());
    if (byName) return byName.id;
  }
  if (focusedChildId && kids.some((c) => c.id === focusedChildId)) return focusedChildId;
  return kids[0]?.id ?? '';
}

function QuickLogCard({
  parsed,
  focusedChildId,
  kids,
}: {
  parsed: QuickLogParse;
  focusedChildId: string | null;
  kids: TimelineChild[];
}) {
  const headingId = useId();
  const selectId = useId();
  const whenId = useId();
  const [childId, setChildId] = useState(() =>
    preselectChild(kids, focusedChildId, parsed.childName),
  );
  const [amountMl, setAmountMl] = useState('');
  const [durationMin, setDurationMin] = useState('');
  const [milestone, setMilestone] = useState(parsed.milestone ?? '');
  const [when, setWhen] = useState(() => toLocalInputValue(new Date()));
  const [status, setStatus] = useState<LogState>({ kind: 'idle' });

  const episode = parsed.episode;

  function buildInput(): QuickLogInput | null {
    if (!childId) return null;
    const occurredAt = toOccurredAt(when);
    switch (episode) {
      case 'feed': {
        const value = Number(amountMl);
        if (!amountMl || Number.isNaN(value)) return null;
        return { kind: FEED_EPISODE, childId, amountMl: value, occurredAt };
      }
      case 'nap': {
        const value = Number(durationMin);
        if (!durationMin || Number.isNaN(value)) return null;
        return { kind: NAP_EPISODE, childId, durationMin: value, occurredAt };
      }
      case 'milestone': {
        const text = milestone.trim();
        if (!text) return null;
        return { kind: MILESTONE_EPISODE, childId, milestone: text, occurredAt };
      }
    }
  }

  async function confirm() {
    const input = buildInput();
    if (!input) {
      setStatus({ kind: 'error', message: EMPTY_ERROR[episode] });
      return;
    }
    setStatus({ kind: 'saving' });
    const result: LogResult = await logQuickEpisode(input);
    switch (result.status) {
      case 'logged':
        setStatus({ kind: 'logged' });
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

  if (status.kind === 'dismissed') return null;

  if (status.kind === 'logged') {
    return (
      <section aria-labelledby={headingId} className="panel-oat px-5 py-4 max-w-prose">
        <p id={headingId} className="field-label">
          {EPISODE_LABEL[episode]}
        </p>
        <output className="meta italic text-spruce block" aria-live="polite">
          logged — kept in your companion.
        </output>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="panel-oat px-5 py-4 space-y-4 max-w-prose">
      <p id={headingId} className="field-label">
        {EPISODE_LABEL[episode]}
      </p>

      {kids.length > 1 ? (
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
            {kids.map((child) => (
              <option key={child.id} value={child.id} data-hale-pii>
                {child.label ?? 'your teen'}
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
        {parsed.timeHint ? (
          <p className="field-hint">you said “{parsed.timeHint}” — adjust if needed</p>
        ) : null}
      </div>

      {episode === 'feed' ? (
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

      {episode === 'nap' ? (
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

      {episode === 'milestone' ? (
        <Field
          label="what happened"
          required
          maxLength={280}
          value={milestone}
          onChange={(e) => setMilestone(e.currentTarget.value)}
          placeholder="rolled over for the first time"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={confirm}
          disabled={status.kind === 'saving'}
        >
          {status.kind === 'saving' ? 'saving…' : 'Confirm'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setStatus({ kind: 'dismissed' })}
        >
          Not now
        </button>
      </div>

      <output className="meta italic block" aria-live="polite">
        {status.kind === 'error' ? (
          <span className="text-apricot-deep" role="alert">
            {status.message}
          </span>
        ) : status.kind === 'preview' ? (
          <span className="text-slate-green">
            development preview — sign-in isn’t configured, so this log wasn’t saved.
          </span>
        ) : (
          ''
        )}
      </output>
    </section>
  );
}

type PlanState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'error'; message: string }
  | { kind: 'dismissed' };

/** The TimelineChild scope shape → the ChildScope option shape. A teen's given
 * name is already withheld upstream (label null — rule #1), so this only forwards. */
function toScopeChildren(kids: TimelineChild[]): ScopeChild[] {
  return kids.map((c) => ({ id: c.id, label: c.label }));
}

/** Pre-select the plan's scope: a parsed child name (a teen's label is null, so a
 * name match only lands on a non-teen), else the focused child, else whole family
 * (null) — matching AddPlan's default. Family-scoped: only this family's kids. */
function preselectPlanChild(
  kids: TimelineChild[],
  focusedChildId: string | null,
  childName: string | undefined,
): string | null {
  if (childName) {
    const byName = kids.find((c) => c.label?.toLowerCase() === childName.toLowerCase());
    if (byName) return byName.id;
  }
  if (focusedChildId && kids.some((c) => c.id === focusedChildId)) return focusedChildId;
  return null;
}

/**
 * The plan-authoring confirm card — the parent's OWN private plan, no approval
 * gate (unlike the Hale-acts ActionConfirmCard). Pre-filled from the parsed
 * instruction (title + child) and EDITABLE before Confirm, which calls the shared
 * createPlan action (private-by-default, family-scoped, one audit row — rule #6).
 * Same panel-oat treatment + aria-live announcements as QuickLogCard; the honest
 * preview copy mirrors it when sign-in isn't configured.
 */
function CreatePlanCard({
  parsed,
  focusedChildId,
  kids,
}: {
  parsed: PlanLogParse;
  focusedChildId: string | null;
  kids: TimelineChild[];
}) {
  const headingId = useId();
  const whenId = useId();
  const [title, setTitle] = useState(parsed.title ?? '');
  const [scheduledFor, setScheduledFor] = useState('');
  const [childId, setChildId] = useState<string | null>(() =>
    preselectPlanChild(kids, focusedChildId, parsed.childName),
  );
  const [status, setStatus] = useState<PlanState>({ kind: 'idle' });

  async function confirm() {
    if (!title.trim()) {
      setStatus({ kind: 'error', message: 'enter what the plan is before saving' });
      return;
    }
    setStatus({ kind: 'saving' });
    const result = await createPlan({
      title,
      notes: null,
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      childId,
    });
    switch (result.status) {
      case 'created':
        setStatus({ kind: 'saved' });
        break;
      case 'preview':
        setStatus({ kind: 'preview' });
        break;
      case 'foreign_child':
        setStatus({ kind: 'error', message: 'that child is not in your family' });
        break;
      case 'not_found':
        setStatus({ kind: 'error', message: 'couldn’t find your family — try again' });
        break;
      case 'invalid':
        setStatus({
          kind: 'error',
          message:
            result.error === 'title_required'
              ? 'enter what the plan is before saving'
              : 'that date didn’t look right — adjust it',
        });
        break;
    }
  }

  if (status.kind === 'dismissed') return null;

  if (status.kind === 'saved') {
    return (
      <section aria-labelledby={headingId} className="panel-oat px-5 py-4 max-w-prose">
        <p id={headingId} className="field-label">
          Add to your plan
        </p>
        <output className="meta italic text-spruce block" aria-live="polite">
          added to your week.
        </output>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="panel-oat px-5 py-4 space-y-4 max-w-prose">
      <p id={headingId} className="field-label">
        Add to your plan
      </p>

      <Field
        label="what's the plan"
        type="text"
        required
        value={title}
        onChange={(e) => {
          setTitle(e.currentTarget.value);
          if (status.kind === 'error') setStatus({ kind: 'idle' });
        }}
        placeholder="swimming registration"
      />

      <div className="field-group">
        <label htmlFor={whenId} className="field-label">
          when
        </label>
        <input
          id={whenId}
          type="date"
          className="field"
          value={scheduledFor}
          onChange={(e) => setScheduledFor(e.currentTarget.value)}
        />
      </div>

      <div className="field-group">
        <span className="field-label">who is this for</span>
        <ChildScope
          variant="select"
          legend="who is this plan for"
          kids={toScopeChildren(kids)}
          value={childId}
          onChange={setChildId}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={confirm}
          disabled={status.kind === 'saving'}
        >
          {status.kind === 'saving' ? 'saving…' : 'Confirm'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setStatus({ kind: 'dismissed' })}
        >
          Not now
        </button>
      </div>

      <output className="meta italic block" aria-live="polite">
        {status.kind === 'error' ? (
          <span className="text-apricot-deep" role="alert">
            {status.message}
          </span>
        ) : status.kind === 'preview' ? (
          <span className="text-slate-green">
            development preview — sign-in isn’t configured, so this plan wasn’t saved.
          </span>
        ) : (
          ''
        )}
      </output>
    </section>
  );
}
