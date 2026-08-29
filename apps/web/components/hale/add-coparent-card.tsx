'use client';

import { Copy, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Modal } from '~/components/ui/modal';
import {
  mintCoParentJoinLink,
  revokeCoParentJoinLinks,
} from '~/app/(authed)/family/join-actions';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

/** The honest quota line — the single-use + 7-day TTL the join rail actually enforces. */
export const ONE_SEAT_LINE =
  'One link, one seat. It stops working the moment your co-parent joins, and expires after 7 days.';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' }).format(new Date(value));
}

type MintState =
  | { kind: 'idle' }
  | { kind: 'minting' }
  | { kind: 'ready'; link: string; copied: boolean }
  | { kind: 'unavailable' }
  | { kind: 'error' };

/**
 * "Add your co-parent" (the /family people card), on the SMS join rail: the mint
 * server action revokes-then-mints (one live link), and the raw link is shown ONCE,
 * here in the modal — only its digest is stored, so the persistent card can render
 * status + Revoke but never the link again (magic-link semantics). A clipboard-blocked
 * browser still sees the link to copy by hand, the same honesty invite-coparent kept.
 */
export function AddCoParentCard({
  openInvite,
}: {
  /** The family's outstanding link, if one is out — status only, never the code. */
  openInvite: { expiresAt: string } | null;
}) {
  const router = useRouter();
  const capture = useAnalytics();
  const [mint, setMint] = useState<MintState>({ kind: 'idle' });
  const [revoking, setRevoking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function createLink() {
    setMint({ kind: 'minting' });
    setNote(null);
    try {
      const result = await mintCoParentJoinLink();
      if (result.status === 'minted') {
        capture('first_invite');
        setMint({ kind: 'ready', link: result.link, copied: false });
        return;
      }
      setMint({ kind: 'unavailable' });
    } catch {
      setMint({ kind: 'error' });
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setMint({ kind: 'ready', link, copied: true });
    } catch {
      setMint({ kind: 'ready', link, copied: false });
    }
  }

  async function revoke() {
    setRevoking(true);
    setNote(null);
    try {
      await revokeCoParentJoinLinks();
      router.refresh();
    } catch {
      setNote('Couldn’t revoke that just now — please try again.');
    } finally {
      setRevoking(false);
    }
  }

  function closeModal() {
    // The raw link dies with the modal; the refreshed card shows status + Revoke.
    setMint({ kind: 'idle' });
    router.refresh();
  }

  return (
    <div className="panel-oat px-6 py-5 max-w-md">
      <p className="font-medium text-spruce">Add your co-parent</p>
      <p className="meta mt-1 leading-relaxed">
        They get everything you get — full access, free.
      </p>

      {openInvite ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="meta text-slate-green">
            A link is out — expires {formatDate(openInvite.expiresAt)}.
          </p>
          <Button variant="secondary" onClick={revoke} disabled={revoking} aria-live="polite">
            {revoking ? 'Revoking…' : 'Revoke'}
          </Button>
          <Button
            variant="ghost"
            onClick={createLink}
            disabled={mint.kind === 'minting' || revoking}
          >
            {mint.kind === 'minting' ? 'Creating…' : 'Create a new link'}
          </Button>
        </div>
      ) : (
        <div className="mt-4">
          <Button icon={UserPlus} onClick={createLink} disabled={mint.kind === 'minting'}>
            {mint.kind === 'minting' ? 'Creating…' : 'Create link'}
          </Button>
        </div>
      )}

      {mint.kind === 'unavailable' ? (
        <output className="meta text-slate-green mt-3 block">
          Your link will be ready once your family is set up.
        </output>
      ) : null}
      {mint.kind === 'error' ? (
        <p className="meta text-berry mt-3" role="alert">
          Couldn’t create a link just now — please try again.
        </p>
      ) : null}
      {note ? (
        <p className="meta text-berry mt-3" role="alert">
          {note}
        </p>
      ) : null}

      {mint.kind === 'ready' ? (
        <Modal title="Your co-parent link" onClose={closeModal}>
          <div className="space-y-4">
            <p className="text-spruce leading-relaxed">
              Forward this to your co-parent. Opening it pre-writes their first text to Hale —
              sending it is how they join.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <p className="font-display text-lg break-all" data-hale-pii>
                {mint.link}
              </p>
              <Button
                variant="secondary"
                icon={Copy}
                onClick={() => copy(mint.link)}
                aria-live="polite"
              >
                {mint.copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
            <p className="meta leading-relaxed">{ONE_SEAT_LINE}</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
