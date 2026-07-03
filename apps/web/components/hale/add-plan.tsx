'use client';

import { AlertCircle, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { createPlan } from '~/lib/plan/plan-actions';
import { ChildScope, type ScopeChild } from './child-scope';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'error' };

/**
 * The "add a plan" affordance on the Plan page: a parent writes their own private
 * plan (a title, optional notes, an optional date) and assigns it to the whole
 * family or one child via ChildScope (select variant). Collapsed to a single
 * button until opened, so it doesn't crowd the week view. On save it calls
 * createPlan (which family-scopes, audits, and revalidates /plan) and resets.
 */
export function AddPlan({ kids }: { kids: ScopeChild[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [childId, setChildId] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });

  function reset() {
    setTitle('');
    setNotes('');
    setScheduledFor('');
    setChildId(null);
  }

  async function submit() {
    setState({ kind: 'saving' });
    const result = await createPlan({
      title,
      notes: notes.trim() ? notes : null,
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      childId,
    });
    if (result.status === 'created') {
      reset();
      setOpen(false);
      setState({ kind: 'saved' });
      return;
    }
    setState(result.status === 'preview' ? { kind: 'preview' } : { kind: 'error' });
  }

  if (!open) {
    return (
      <div>
        <Button variant="secondary" icon={Plus} onClick={() => setOpen(true)}>
          add a plan
        </Button>
        {state.kind === 'saved' ? (
          <output className="meta text-slate-green block mt-3">added to your week.</output>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="space-y-5 max-w-lg"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field
        label="what's the plan"
        name="title"
        type="text"
        required
        value={title}
        onChange={(e) => {
          setTitle(e.currentTarget.value);
          setState({ kind: 'idle' });
        }}
        placeholder="swimming registration"
      />
      <Field
        label="notes"
        name="notes"
        multiline
        rows={3}
        hint="optional — anything you want to remember"
        value={notes}
        onChange={(e) => setNotes(e.currentTarget.value)}
      />
      <Field
        label="when"
        name="scheduledFor"
        type="date"
        hint="optional"
        value={scheduledFor}
        onChange={(e) => setScheduledFor(e.currentTarget.value)}
      />
      <div className="field-group">
        <span className="field-label">who is this for</span>
        <ChildScope
          variant="select"
          legend="who is this plan for"
          kids={kids}
          value={childId}
          onChange={setChildId}
        />
      </div>

      {state.kind === 'preview' ? (
        <output className="meta text-slate-green block">
          sign-in isn&rsquo;t configured in this preview, so nothing was saved.
        </output>
      ) : null}
      {state.kind === 'error' ? (
        <p className="field-error flex items-center gap-2" role="alert">
          <AlertCircle size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          couldn&rsquo;t save just now — please try again.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={Plus} type="submit" disabled={state.kind === 'saving'}>
          {state.kind === 'saving' ? 'saving…' : 'save plan'}
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
            setState({ kind: 'idle' });
          }}
        >
          cancel
        </Button>
      </div>
    </form>
  );
}
