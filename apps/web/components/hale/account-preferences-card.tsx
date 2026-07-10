'use client';

import { AlertCircle, Check } from 'lucide-react';
import { useState } from 'react';
import { humanizeUnits } from '~/components/hale/account-profile-card';
import { PreferenceToggle } from '~/components/hale/preference-toggle';
import { Button } from '~/components/ui/button';
import type { ViewerProfile } from '~/lib/family';
import { setPreferencesAction } from '~/lib/family/children-actions';
import { PREVIEW_NOTE, SIGNED_OUT_NOTE } from '~/lib/family/form-copy';
import type { UnitSystem } from '@hale/types';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'signed_out' }
  | { kind: 'error' };

const UNIT_OPTIONS = [
  { value: 'metric', label: 'Metric' },
  { value: 'imperial', label: 'Imperial' },
];

const WEEK_START_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '0', label: 'Sunday' },
];

/**
 * The display preferences the `users` row actually holds: Units (a DISPLAY choice —
 * storage stays metric) and the first day of the week (which reorders the plan
 * spine). Both really change what the parent sees, so the controls are honest (rule
 * #1). Mirrors FamilyParent's save state machine + feedback; the write is audited
 * server-side (rule #6).
 */
export function AccountPreferencesCard({ profile }: { profile: ViewerProfile }) {
  const [units, setUnits] = useState<string>(profile.units);
  const [weekStart, setWeekStart] = useState<string>(String(profile.weekStartDay));
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit() {
    setState({ kind: 'saving' });
    const result = await setPreferencesAction(units as UnitSystem, Number(weekStart));
    if (result.status === 'updated') {
      setState({ kind: 'saved' });
      return;
    }
    if (result.status === 'preview') {
      setState({ kind: 'preview' });
      return;
    }
    if (result.status === 'unauthenticated') {
      setState({ kind: 'signed_out' });
      return;
    }
    setState({ kind: 'error' });
  }

  return (
    <div className="card space-y-8">
      <form
        className="space-y-8"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-3">
          <dt className="field-label">units</dt>
          <PreferenceToggle
            legend="Units"
            options={UNIT_OPTIONS}
            value={units}
            onChange={(v) => {
              setUnits(v);
              setState({ kind: 'idle' });
            }}
          />
          <p className="meta text-slate-green">{humanizeUnits(units)}</p>
        </div>

        <div className="space-y-3">
          <dt className="field-label">first day of week</dt>
          <PreferenceToggle
            legend="First day of week"
            options={WEEK_START_OPTIONS}
            value={weekStart}
            onChange={(v) => {
              setWeekStart(v);
              setState({ kind: 'idle' });
            }}
          />
        </div>

        {state.kind === 'saved' ? (
          <output className="meta text-slate-green block">saved.</output>
        ) : null}
        {state.kind === 'preview' ? (
          <output className="meta text-slate-green block">{PREVIEW_NOTE}</output>
        ) : null}
        {state.kind === 'signed_out' ? (
          <output className="meta text-slate-green block">{SIGNED_OUT_NOTE}</output>
        ) : null}
        {state.kind === 'error' ? (
          <p className="field-error flex items-center gap-2" role="alert">
            <AlertCircle size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />
            couldn&rsquo;t save just now — please try again.
          </p>
        ) : null}
        <Button variant="secondary" icon={Check} type="submit" disabled={state.kind === 'saving'}>
          {state.kind === 'saving' ? 'saving…' : 'save preferences'}
        </Button>
      </form>
    </div>
  );
}
