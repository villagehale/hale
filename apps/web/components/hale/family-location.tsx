'use client';

import { AlertCircle, MapPin } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { setLocationAction } from '~/lib/family/children-actions';
import type { FamilyLocationView } from '~/lib/dashboard/family-basics';

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'preview' }
  | { kind: 'error' };

/**
 * Shows and edits the family's structured location: country, province / state,
 * city, postal code. The postal code is the finest grain Hale stores — it drives
 * neighbourhood discovery but is never surfaced precisely (rule #1). Clearing every
 * field opts the family out of local discovery (all nullable).
 */
export function FamilyLocation({ location }: { location: FamilyLocationView }) {
  const [country, setCountry] = useState(location.country ?? '');
  const [province, setProvince] = useState(location.province ?? '');
  const [city, setCity] = useState(location.city ?? '');
  const [postalCode, setPostalCode] = useState(location.postalCode ?? '');
  const [state, setState] = useState<State>({ kind: 'idle' });

  function touched() {
    setState({ kind: 'idle' });
  }

  async function submit() {
    setState({ kind: 'saving' });
    const result = await setLocationAction({ country, province, city, postalCode });
    if (result.status === 'updated') {
      setState({ kind: 'saved' });
      return;
    }
    setState(result.status === 'preview' ? { kind: 'preview' } : { kind: 'error' });
  }

  return (
    <form
      className="space-y-5 max-w-lg"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <Field
          label="country"
          name="country"
          type="text"
          value={country}
          onChange={(e) => {
            setCountry(e.currentTarget.value);
            touched();
          }}
          placeholder="Canada"
          autoComplete="country-name"
        />
        <Field
          label="province / state"
          name="province"
          type="text"
          value={province}
          onChange={(e) => {
            setProvince(e.currentTarget.value);
            touched();
          }}
          placeholder="Ontario"
          autoComplete="address-level1"
        />
        <Field
          label="city"
          name="city"
          type="text"
          value={city}
          onChange={(e) => {
            setCity(e.currentTarget.value);
            touched();
          }}
          placeholder="Toronto"
          autoComplete="address-level2"
        />
        <Field
          label="postal code"
          name="postalCode"
          type="text"
          hint="drives neighbourhood discovery — never a precise address"
          value={postalCode}
          onChange={(e) => {
            setPostalCode(e.currentTarget.value);
            touched();
          }}
          placeholder="M5V 2T6"
          autoComplete="postal-code"
        />
      </div>
      {state.kind === 'saved' ? (
        <output className="meta text-slate-green block">saved.</output>
      ) : null}
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
      <Button variant="secondary" icon={MapPin} type="submit" disabled={state.kind === 'saving'}>
        {state.kind === 'saving' ? 'saving…' : 'save location'}
      </Button>
    </form>
  );
}
