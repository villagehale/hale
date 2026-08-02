'use client';

import { useActionState } from 'react';
import {
  type RevokeTeenAccessState,
  revokeTeenAccessAction,
} from '~/app/(authed)/settings/teen-access-actions';

const INITIAL_STATE: RevokeTeenAccessState = { status: 'idle' };

export function TeenAccessRevokeForm({ grantId }: { grantId: string }) {
  const [state, formAction, pending] = useActionState(revokeTeenAccessAction, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1 sm:items-end">
      <input type="hidden" name="grantId" value={grantId} />
      <button
        type="submit"
        className="meta text-berry underline underline-offset-4 cursor-pointer disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
      >
        {pending ? 'closing…' : 'close access'}
      </button>
      {state.status !== 'idle' ? (
        <output className={state.status === 'error' ? 'meta text-berry' : 'meta text-faded-sage'}>
          {state.message}
        </output>
      ) : null}
    </form>
  );
}
