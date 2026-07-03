'use client';

import { AlertCircle, Check } from 'lucide-react';
import { useState } from 'react';
import type { OnboardingIntent } from '@hale/types';
import { Button } from '~/components/ui/button';
import { IntentChips } from '~/components/hale/intent-chips';
import { setIntentsAction } from '~/lib/family/children-actions';
import { PREVIEW_NOTE, SIGNED_OUT_NOTE } from '~/lib/family/form-copy';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'signed_out' }
  | { kind: 'error' };

/**
 * Shows and edits what the family hopes Hale can help with. Optional — clearing
 * every chip is a valid "none". A save writes immediately and audits
 * family_intents_updated (rule #6).
 */
export function FamilyIntents({ intents }: { intents: OnboardingIntent[] }) {
  const [selected, setSelected] = useState<OnboardingIntent[]>(intents);
  const [state, setState] = useState<State>({ kind: 'idle' });

  function toggle(value: OnboardingIntent) {
    setState({ kind: 'idle' });
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  async function submit() {
    setState({ kind: 'saving' });
    const result = await setIntentsAction(selected);
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
    <div className="space-y-5 max-w-lg">
      <IntentChips
        legend="what you're hoping for"
        selected={selected}
        onToggle={toggle}
        disabled={state.kind === 'saving'}
      />
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
      <Button variant="secondary" icon={Check} onClick={submit} disabled={state.kind === 'saving'}>
        {state.kind === 'saving' ? 'saving…' : 'save'}
      </Button>
    </div>
  );
}
