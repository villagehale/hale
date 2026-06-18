'use client';

import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { setAreaAction } from '~/lib/family/children-actions';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'error' };

/**
 * Shows and edits the family's coarse area (families.areaCoarse) — a
 * neighbourhood or postal FSA, never a precise address (rule #1). An empty value
 * clears it, opting the family out of local discovery.
 */
export function FamilyArea({ area }: { area: string | null }) {
  const [value, setValue] = useState(area ?? '');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit() {
    setState({ kind: 'saving' });
    const result = await setAreaAction(value);
    if (result.status === 'updated') {
      setState({ kind: 'saved' });
      return;
    }
    setState(result.status === 'preview' ? { kind: 'preview' } : { kind: 'error' });
  }

  return (
    <form
      className="space-y-4 max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field
        label="your area"
        name="area"
        type="text"
        hint="a neighbourhood or postal FSA (e.g. M4L) — never a precise address"
        value={value}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          setState({ kind: 'idle' });
        }}
        placeholder="M4L"
        autoComplete="off"
      />
      {state.kind === 'saved' ? (
        <output className="meta text-slate-green block">saved.</output>
      ) : null}
      {state.kind === 'preview' ? (
        <output className="meta text-slate-green block">
          sign-in isn&rsquo;t configured in this preview, so nothing was saved.
        </output>
      ) : null}
      {state.kind === 'error' ? (
        <p className="meta text-apricot-deep" role="alert">
          couldn&rsquo;t save just now — please try again.
        </p>
      ) : null}
      <Button variant="secondary" icon={MapPin} type="submit" disabled={state.kind === 'saving'}>
        {state.kind === 'saving' ? 'saving…' : 'save area'}
      </Button>
    </form>
  );
}
