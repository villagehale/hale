'use client';

import { MapPin } from 'lucide-react';
import { useState } from 'react';
import type { FamilyLocationView } from '~/lib/dashboard/family-basics';
import { setLocationAction } from '~/lib/family/children-actions';
import styles from './portal.module.css';

/**
 * Postal code only. Country, province and city stay on the family row — a save
 * passes them through — and the closed row never prints the code.
 */
export function PostalEditor({ location }: { location: FamilyLocationView }) {
  const [open, setOpen] = useState(false);
  const [postalCode, setPostalCode] = useState(location.postalCode ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function save() {
    setState('saving');
    const result = await setLocationAction({
      country: location.country ?? '',
      province: location.province ?? '',
      city: location.city ?? '',
      postalCode,
    });
    setState(result.status === 'updated' ? 'saved' : 'error');
  }

  return (
    <div className={`${styles.row} ${styles.tight}`}>
      <span className={styles.tile}>
        <MapPin aria-hidden="true" />
      </span>
      <span>
        <h3>Postal code</h3>
        <p className={styles.meta}>Used for nearby ideas. Never shared.</p>
        {open ? (
          <form
            className={styles.quietEdit}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              Postal code
              <input
                name="postalCode"
                type="text"
                autoComplete="postal-code"
                value={postalCode}
                data-hale-pii
                onChange={(event) => {
                  setPostalCode(event.currentTarget.value);
                  setState('idle');
                }}
              />
            </label>
            <button type="submit" className={styles.secondary} disabled={state === 'saving'}>
              {state === 'saving' ? 'saving…' : 'save'}
            </button>
          </form>
        ) : null}
        {state === 'saved' ? <p className={styles.meta}>saved.</p> : null}
        {state === 'error' ? (
          <p className={styles.note} role="alert">
            couldn’t save that just now — try again.
          </p>
        ) : null}
      </span>
      {open ? null : (
        <span className={styles.end}>
          <button type="button" className={styles.secondary} onClick={() => setOpen(true)}>
            Edit
          </button>
        </span>
      )}
    </div>
  );
}
