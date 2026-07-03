'use client';

import { useState } from 'react';

type State = 'idle' | 'pending' | 'done' | 'error';

const LABEL: Record<State, string> = {
  idle: 'download a copy',
  pending: 'preparing…',
  done: 'downloaded',
  error: 'could not export — try again',
};

/**
 * Downloads everything Hale holds about the family (PIPEDA/Law 25 right-to-access
 * + portability) from /api/rights/export. Fetches the JSON, then saves it via a
 * blob URL so an auth/permission error surfaces here rather than navigating the
 * parent to a raw error page. The export is already teen-redacted server-side —
 * this only saves what the server returns. Honest states: pending in flight,
 * "downloaded" on success, the error surfaced — never a silent failure.
 */
export function ExportDataButton() {
  const [state, setState] = useState<State>('idle');

  async function download() {
    setState('pending');
    try {
      const res = await fetch('/api/rights/export');
      if (!res.ok) {
        setState('error');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `hale-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setState('done');
    } catch {
      setState('error');
    }
  }

  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={download}
      disabled={state === 'pending'}
      aria-live="polite"
    >
      {LABEL[state]}
    </button>
  );
}
