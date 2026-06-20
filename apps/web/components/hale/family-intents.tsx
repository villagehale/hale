'use client';

import { Check } from 'lucide-react';
import { useState } from 'react';
import type { OnboardingIntent } from '@hale/types';
import { Button } from '~/components/ui/button';
import { IntentChips } from '~/components/hale/intent-chips';
import { setIntentsAction } from '~/lib/family/children-actions';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
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
    setState(result.status === 'preview' ? { kind: 'preview' } : { kind: 'error' });
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
        <output className="meta text-slate-green block">
          sign-in isn&rsquo;t configured in this preview, so nothing was saved.
        </output>
      ) : null}
      {state.kind === 'error' ? (
        <p className="meta text-apricot-deep" role="alert">
          couldn&rsquo;t save just now — please try again.
        </p>
      ) : null}
      <Button variant="secondary" icon={Check} onClick={submit} disabled={state.kind === 'saving'}>
        {state.kind === 'saving' ? 'saving…' : 'save'}
      </Button>
    </div>
  );
}
