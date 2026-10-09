'use client';

import { useState } from 'react';
import { setParentNameAction } from '~/lib/family/children-actions';
import styles from './portal.module.css';

export function NameEditor({ name }: { name: string | null }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function save() {
    setState('saving');
    const result = await setParentNameAction(value);
    setState(result.status === 'updated' ? 'saved' : 'error');
  }

  return (
    <div className={`${styles.row} ${styles.tight}`}>
      <span>
        <h3>Name</h3>
        {value.trim() ? (
          <p className={styles.meta} data-hale-pii>
            {value.trim()}
          </p>
        ) : null}
        {open ? (
          <form
            className={styles.quietEdit}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              Name
              <input
                name="parentName"
                type="text"
                required
                autoComplete="name"
                value={value}
                data-hale-pii
                onChange={(event) => {
                  setValue(event.currentTarget.value);
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
