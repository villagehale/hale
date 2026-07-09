'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ConnectionSummary } from '~/lib/integrations/store';

/** The connectors a family can link — read-only Google services that feed the pipeline. */
const CONNECTORS = [
  { provider: 'gcal', label: 'Google Calendar', blurb: 'appointments, events, and reminders' },
  { provider: 'gmail', label: 'Gmail', blurb: 'confirmations, forms, and benefit letters' },
  { provider: 'gdrive', label: 'Google Drive', blurb: 'documents you point Hale to' },
] as const;

export function Connectors({ connections }: { connections: ConnectionSummary[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const isActive = (provider: string) =>
    connections.some((c) => c.provider === provider && c.status === 'active');

  async function disconnect(provider: string) {
    setBusy(provider);
    try {
      await fetch(`/api/integrations/${provider}/disconnect`, { method: 'POST' });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-y-5">
      <p className="text-spruce leading-relaxed max-w-md">
        Hale never reaches outside your family until you connect a service — read-only, and you can
        disconnect any time. Connections only feed drafts you approve; nothing acts on its own.
      </p>
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {CONNECTORS.map((c) => {
          const connected = isActive(c.provider);
          return (
            <li key={c.provider} className="flex items-center justify-between gap-x-6 py-4">
              <div>
                <span className="font-medium">{c.label}</span>
                <p className="meta mt-0.5">{c.blurb}</p>
              </div>
              {connected ? (
                <button
                  type="button"
                  onClick={() => disconnect(c.provider)}
                  disabled={busy === c.provider}
                  className="meta text-berry underline underline-offset-4 cursor-pointer disabled:opacity-50"
                >
                  {busy === c.provider ? 'disconnecting…' : 'disconnect'}
                </button>
              ) : (
                <a
                  href={`/api/integrations/${c.provider}/connect`}
                  className="meta text-spruce underline underline-offset-4"
                >
                  connect
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
