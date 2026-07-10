'use client';

import { CalendarCheck, Moon, Pencil, Sparkles, Stethoscope, Trash2, Utensils, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { ChildScope, type ScopeChild } from '~/components/hale/child-scope';
import { Icon } from '~/components/ui/icon';
import { deleteQuickEpisode, editQuickEpisode } from '~/lib/companion/log';
import {
  BOOKING_EPISODE,
  type DeleteResult,
  type EditResult,
  FEED_EPISODE,
  MEASURE_META,
  MEASUREMENT_EPISODE,
  MILESTONE_EPISODE,
  NAP_EPISODE,
} from '~/lib/companion/log-types';
import { groupLogsByDay, type LogsPage, type LogView } from '~/lib/companion/logs-view';
import { displayMeasurement, type MeasureKind, type UnitSystem } from '@hale/types';

const ICON: Record<string, LucideIcon> = {
  [FEED_EPISODE]: Utensils,
  [NAP_EPISODE]: Moon,
  [MILESTONE_EPISODE]: Sparkles,
  [BOOKING_EPISODE]: Stethoscope,
};

const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

const TIME_LABEL = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function dayHeading(dayKey: string): string {
  // dayKey is YYYY-MM-DD in local time; noon avoids any DST edge shifting the date.
  return DAY_LABEL.format(new Date(`${dayKey}T12:00:00`));
}

function isMeasureKind(v: string | undefined): v is MeasureKind {
  return v === 'weight' || v === 'height' || v === 'head';
}

/**
 * The text a log row shows. A measurement row's summary is baked from the STORED
 * METRIC value, so under an imperial preference we re-format it from the lifted
 * value + kind rather than showing the stale metric string — keeping the diary
 * consistent with the growth card. The phrasing mirrors the write path (a weight
 * "Weighed", other kinds "{label}"). Any non-measurement row (or a measurement
 * missing its lifted numerics) keeps its own summary untouched.
 */
function logRowText(log: LogView, units: UnitSystem): string {
  if (log.episodeType === MEASUREMENT_EPISODE && typeof log.value === 'number' && isMeasureKind(log.measureKind)) {
    const shown = displayMeasurement(log.value, log.measureKind, units);
    const prefix = log.measureKind === 'weight' ? 'Weighed' : MEASURE_META[log.measureKind].label;
    return `${prefix} ${shown.value} ${shown.unit}`;
  }
  return log.summary;
}

/**
 * The dedicated, scalable logs view: a per-child ChildScope filter over a
 * day-grouped, load-more list of the family's quick-logs, with inline edit +
 * soft-delete per row. Teen labels are withheld (rule #1) — the caller passes
 * `kids` with a null label for a 13+ child. The first page is server-rendered
 * (initial); switching the filter or loading more fetches /api/companion/logs.
 *
 * Meadow-styled with existing tokens only (oat panels, pills, .link, .btn-*);
 * radius ≤ 16px (--r-lg/--r-xl); tone by label + icon shape, never colour alone.
 */
export function LogsBrowser({
  initial,
  kids,
  units,
}: {
  initial: LogsPage;
  kids: ScopeChild[];
  units: UnitSystem;
}) {
  const [childId, setChildId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogView[]>(initial.logs);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPage(scope: string | null, before: string | null): Promise<LogsPage> {
    const params = new URLSearchParams();
    if (scope) params.set('child', scope);
    if (before) params.set('before', before);
    const query = params.toString();
    const res = await fetch(`/api/companion/logs${query ? `?${query}` : ''}`);
    if (!res.ok) throw new Error(`logs fetch failed: ${res.status}`);
    return (await res.json()) as LogsPage;
  }

  async function selectChild(next: string | null) {
    if (next === childId) return;
    setChildId(next);
    setBusy(true);
    setError(null);
    try {
      const page = await fetchPage(next, null);
      setLogs(page.logs);
      setCursor(page.nextCursor);
    } catch {
      setError('couldn’t load those logs — try again');
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const page = await fetchPage(childId, cursor);
      setLogs((prev) => [...prev, ...page.logs]);
      setCursor(page.nextCursor);
    } catch {
      setError('couldn’t load more — try again');
    } finally {
      setBusy(false);
    }
  }

  function onEdited(id: string, summary: string, occurredAt: string) {
    setLogs((prev) =>
      prev.map((log) => (log.id === id ? { ...log, summary, occurredAt } : log)),
    );
  }

  function onDeleted(id: string) {
    setLogs((prev) => prev.filter((log) => log.id !== id));
  }

  const groups = groupLogsByDay(logs);

  return (
    <div className="space-y-10">
      {kids.length > 0 ? (
        <ChildScope
          kids={kids}
          value={childId}
          onChange={selectChild}
          variant="filter"
          legend="filter logs by child"
        />
      ) : null}

      {groups.length === 0 ? (
        <p className="text-lg text-spruce leading-relaxed">
          nothing logged for this filter yet — logs you note in your companion gather here.
        </p>
      ) : (
        <div className="space-y-10">
          {groups.map((group) => (
            <section key={group.dayKey} aria-label={dayHeading(group.dayKey)} className="space-y-4">
              <h2 className="eyebrow text-slate-green">{dayHeading(group.dayKey)}</h2>
              <ul className="space-y-3">
                {group.logs.map((log) => (
                  <LogRow
                    key={log.id}
                    log={log}
                    units={units}
                    onEdited={onEdited}
                    onDeleted={onDeleted}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <output className="meta italic block" aria-live="polite">
        {error ? (
          <span className="text-apricot-deep" role="alert">
            {error}
          </span>
        ) : (
          ''
        )}
      </output>

      {cursor ? (
        <button
          type="button"
          className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={loadMore}
          disabled={busy}
        >
          {busy ? 'loading…' : 'load more'}
        </button>
      ) : null}
    </div>
  );
}

function toLocalInputValue(occurredAt: string): string {
  const d = new Date(occurredAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type RowState =
  | { kind: 'view' }
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'confirm-delete' }
  | { kind: 'deleting' }
  | { kind: 'error'; message: string };

function LogRow({
  log,
  units,
  onEdited,
  onDeleted,
}: {
  log: LogView;
  units: UnitSystem;
  onEdited: (id: string, summary: string, occurredAt: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [state, setState] = useState<RowState>({ kind: 'view' });
  const [summary, setSummary] = useState(log.summary);
  const [when, setWhen] = useState(() => toLocalInputValue(log.occurredAt));

  async function save() {
    const nextSummary = summary.trim();
    if (!nextSummary) {
      setState({ kind: 'error', message: 'a log needs a short description' });
      return;
    }
    const occurredAt = new Date(when);
    if (Number.isNaN(occurredAt.getTime())) {
      setState({ kind: 'error', message: 'enter a real date and time' });
      return;
    }
    setState({ kind: 'saving' });
    const result: EditResult = await editQuickEpisode({
      id: log.id,
      summary: nextSummary,
      occurredAt: occurredAt.toISOString(),
    });
    switch (result.status) {
      case 'edited':
        onEdited(log.id, nextSummary, occurredAt.toISOString());
        setState({ kind: 'view' });
        break;
      case 'forbidden':
        setState({ kind: 'error', message: 'that log isn’t yours to edit' });
        break;
      case 'invalid':
        setState({ kind: 'error', message: result.error });
        break;
      case 'preview':
        setState({ kind: 'error', message: 'sign-in isn’t configured — not saved' });
        break;
    }
  }

  async function remove() {
    setState({ kind: 'deleting' });
    const result: DeleteResult = await deleteQuickEpisode({ id: log.id });
    switch (result.status) {
      case 'deleted':
        onDeleted(log.id);
        break;
      case 'forbidden':
        setState({ kind: 'error', message: 'that log isn’t yours to remove' });
        break;
      default:
        setState({ kind: 'error', message: 'couldn’t remove — try again' });
    }
  }

  const editing = state.kind === 'editing' || state.kind === 'saving';

  if (editing) {
    return (
      <li className="panel-oat px-5 py-4 space-y-4">
        <div className="field-group">
          <label htmlFor={`sum-${log.id}`} className="field-label">
            what happened
          </label>
          <input
            id={`sum-${log.id}`}
            className="field"
            value={summary}
            maxLength={280}
            onChange={(e) => setSummary(e.currentTarget.value)}
            data-hale-pii
          />
        </div>
        <div className="field-group">
          <label htmlFor={`when-${log.id}`} className="field-label">
            when
          </label>
          <input
            id={`when-${log.id}`}
            type="datetime-local"
            className="field"
            value={when}
            max={toLocalInputValue(new Date().toISOString())}
            onChange={(e) => setWhen(e.currentTarget.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={save}
            disabled={state.kind === 'saving'}
          >
            {state.kind === 'saving' ? 'saving…' : 'Save'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setState({ kind: 'view' })}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-baseline gap-4 border-t border-rule pt-3 first:border-t-0 first:pt-0">
      <span className="shrink-0 text-apricot-deep">
        <Icon as={ICON[log.episodeType] ?? CalendarCheck} size={18} />
      </span>
      <span className="text-lg text-spruce leading-relaxed flex-1" data-hale-pii>
        {logRowText(log, units)}
      </span>
      <span className="eyebrow text-faded-sage shrink-0">{TIME_LABEL.format(new Date(log.occurredAt))}</span>

      {state.kind === 'confirm-delete' || state.kind === 'deleting' ? (
        <span className="flex items-center gap-2 shrink-0">
          <span className="meta text-slate-green">remove?</span>
          <button
            type="button"
            className="link cursor-pointer"
            onClick={remove}
            disabled={state.kind === 'deleting'}
          >
            {state.kind === 'deleting' ? 'removing…' : 'yes'}
          </button>
          <button
            type="button"
            className="meta cursor-pointer text-slate-green"
            onClick={() => setState({ kind: 'view' })}
          >
            no
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            className="p-2 text-slate-green hover:text-spruce cursor-pointer"
            onClick={() => setState({ kind: 'editing' })}
            aria-label={`edit log: ${logRowText(log, units)}`}
          >
            <Icon as={Pencil} size={16} />
          </button>
          <button
            type="button"
            className="p-2 text-slate-green hover:text-apricot-deep cursor-pointer"
            onClick={() => setState({ kind: 'confirm-delete' })}
            aria-label={`remove log: ${logRowText(log, units)}`}
          >
            <Icon as={Trash2} size={16} />
          </button>
        </span>
      )}

      {state.kind === 'error' ? (
        <span className="basis-full flex items-center gap-2 pl-9 text-apricot-deep meta" role="alert">
          <Icon as={X} size={14} />
          {state.message}
        </span>
      ) : null}
    </li>
  );
}
