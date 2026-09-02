'use client';

import { useActionState } from 'react';
import {
  type DisconnectConnectorState,
  disconnectConnectorAction,
} from '~/app/(authed)/settings/connector-actions';

const INITIAL_STATE: DisconnectConnectorState = { status: 'idle' };

/**
 * Mirrors McpRevokeForm: pending label while the action runs, and the result line
 * renders the action's honest message — including the Google-side truth on
 * success, and a real error when nothing was the caller's to disconnect.
 */
export function ConnectorDisconnectForm({
  provider,
  serviceLabel,
}: {
  provider: string;
  serviceLabel: string;
}) {
  const [state, formAction, pending] = useActionState(disconnectConnectorAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1 sm:items-end">
      <input type="hidden" name="provider" value={provider} />
      <button
        type="submit"
        aria-label={`Disconnect ${serviceLabel}`}
        className="meta text-berry underline underline-offset-4 cursor-pointer disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
      >
        {pending ? 'disconnecting…' : 'disconnect'}
      </button>
      {state.status !== 'idle' ? (
        <output
          className={`${state.status === 'error' ? 'meta text-berry' : 'meta text-faded-sage'} max-w-56 sm:text-right`}
        >
          {state.message}
        </output>
      ) : null}
    </form>
  );
}
