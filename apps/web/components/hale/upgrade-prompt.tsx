'use client';

import { type Entitlement, type PlanTier, hasEntitlement } from '@hale/types';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '~/components/ui/icon';

/**
 * A calm, in-context invitation to the tier that would carry a load the family is
 * currently carrying by hand — shown only at the moment that value lands (an
 * approvals queue, a booking nudge), never as a wall. It is additive: the free
 * action still works (draft-for-approval); this is the quiet "Hale could do this
 * for you" beside it. Renders nothing for a family that already has the
 * entitlement (it would be noise), and stays dismissed once dismissed so it never
 * nags. The CTA is a subtle link to /settings — the plan page (owned elsewhere)
 * is the only place a tier actually changes.
 */
export const UPGRADE_PROMPT_STORAGE_PREFIX = 'hale.upgrade-dismissed.';

/** The per-entitlement localStorage key, so dismissing one prompt never silences another. */
export function upgradePromptStorageKey(entitlement: Entitlement): string {
  return `${UPGRADE_PROMPT_STORAGE_PREFIX}${entitlement}`;
}

/**
 * Whether this prompt should ever render for this family, before dismissal state.
 * Pure so the gate (hide entirely once the entitlement is held) is unit-testable
 * without a DOM.
 */
export function shouldOfferUpgrade(tier: PlanTier, entitlement: Entitlement): boolean {
  return !hasEntitlement(tier, entitlement);
}

export function UpgradePrompt({
  planTier,
  entitlement,
  children,
}: {
  planTier: PlanTier;
  entitlement: Entitlement;
  children: React.ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(upgradePromptStorageKey(entitlement)) === '1') {
      setDismissed(true);
    }
  }, [entitlement]);

  if (!shouldOfferUpgrade(planTier, entitlement) || dismissed) return null;

  function dismiss() {
    localStorage.setItem(upgradePromptStorageKey(entitlement), '1');
    setDismissed(true);
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-rule pt-4">
      <p className="meta text-slate-green">
        {children}{' '}
        <Link href="/settings" className="link">
          see plans →
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss this suggestion"
        className="upgrade-prompt-dismiss"
      >
        <Icon as={X} size={18} className="text-faded-sage" />
      </button>
    </div>
  );
}
