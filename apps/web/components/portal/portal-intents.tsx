'use client';

import type { OnboardingIntent } from '@hale/types';
import { ONBOARDING_INTENTS } from '@hale/types';
import { useState } from 'react';
import { setIntentsAction } from '~/lib/family/children-actions';
import { PREVIEW_NOTE, SIGNED_OUT_NOTE } from '~/lib/family/form-copy';
import styles from './portal.module.css';

type State = 'idle' | 'saving' | 'saved' | 'preview' | 'signed_out' | 'error';

/**
 * Portal chips for what the family wants help with. The card tag is the only
 * heading — this does not repeat it.
 */
export function PortalIntents({ intents }: { intents: OnboardingIntent[] }) {
  const [selected, setSelected] = useState<OnboardingIntent[]>(intents);
  const [state, setState] = useState<State>('idle');

  function toggle(value: OnboardingIntent) {
    setState('idle');
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value],
    );
  }

  async function submit() {
    setState('saving');
    const result = await setIntentsAction(selected);
    if (result.status === 'updated') {
      setState('saved');
      return;
    }
    if (result.status === 'preview') {
      setState('preview');
      return;
    }
    if (result.status === 'unauthenticated') {
      setState('signed_out');
      return;
    }
    setState('error');
  }

  return (
    <>
      <div className={styles.intents}>
        {ONBOARDING_INTENTS.map(({ value, label }) => {
          const on = selected.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              disabled={state === 'saving'}
              className={on ? `${styles.intent} ${styles.intentOn}` : styles.intent}
              onClick={() => toggle(value)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {state === 'saved' ? <p className={styles.meta}>saved.</p> : null}
      {state === 'preview' ? <p className={styles.meta}>{PREVIEW_NOTE}</p> : null}
      {state === 'signed_out' ? <p className={styles.meta}>{SIGNED_OUT_NOTE}</p> : null}
      {state === 'error' ? (
        <p className={styles.note} role="alert">
          couldn’t save just now — please try again.
        </p>
      ) : null}
      <button
        type="button"
        className={`${styles.secondary} ${styles.block}`}
        onClick={() => void submit()}
        disabled={state === 'saving'}
      >
        {state === 'saving' ? 'Saving…' : 'Save'}
      </button>
    </>
  );
}
