'use client';

import { X } from 'lucide-react';
import { useId, useState } from 'react';
import { deletePlan } from '~/lib/plan/plan-actions';

/**
 * Removes a parent-authored plan. Calls deletePlan (family-scoped + audited +
 * revalidates /plan). Disabled while the delete is in flight so a double-click
 * can't fire twice.
 */
export function DeletePlanButton({
  planId,
  labelledBy,
}: {
  planId: string;
  /** The id of the card's plan-title node — see the aria-labelledby note below. */
  labelledBy?: string;
}) {
  const [pending, setPending] = useState(false);
  const selfId = useId();

  async function onDelete() {
    setPending(true);
    const result = await deletePlan(planId);
    if (result.status !== 'deleted') {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      id={selfId}
      onClick={onDelete}
      disabled={pending}
      // Per-row plans all carry an identical "remove" control, so the plan's title
      // joins the accessible name — by REFERENCE to the card's title node, never as
      // an `aria-label` copy, which a replay would record verbatim (VIL-276). The
      // control shows only an icon, so it carries its own verb as sr-only text.
      aria-labelledby={labelledBy ? `${selfId} ${labelledBy}` : undefined}
      className="pill pill-action cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <X size={14} strokeWidth={2} aria-hidden="true" />
      <span className="sr-only">remove plan</span>
    </button>
  );
}
