'use client';

import { AlertCircle, Check } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { setParentNameAction } from '~/lib/family/children-actions';
import { PREVIEW_NOTE, SIGNED_OUT_NOTE } from '~/lib/family/form-copy';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'signed_out' }
  | { kind: 'error' };

/**
 * Shows and edits the parent's display name (the mirrored Google name). The email
 * comes free from Google and is shown read-only — it is the account identity and is
 * never re-entered.
 */
export function FamilyParent({ name, email }: { name: string | null; email: string }) {
  const [value, setValue] = useState(name ?? '');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit() {
    setState({ kind: 'saving' });
    const result = await setParentNameAction(value);
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
    <form
      className="space-y-5 max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field
        label="your name"
        name="parentName"
        type="text"
        required
        value={value}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          setState({ kind: 'idle' });
        }}
        placeholder="your name"
        autoComplete="name"
      />
      <div>
        <p className="field-label">email</p>
        <p className="font-display text-[1.25rem] mt-1 break-words" data-hale-pii>
          {email}
        </p>
        <p className="meta mt-1">from your Google account — your account identity.</p>
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
        {state.kind === 'saving' ? 'saving…' : 'save name'}
      </Button>
    </form>
  );
}
