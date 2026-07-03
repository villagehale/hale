'use client';

import { X } from 'lucide-react';
import { useState } from 'react';
import { deletePlan } from '~/lib/plan/plan-actions';

/**
 * Removes a parent-authored plan. Calls deletePlan (family-scoped + audited +
 * revalidates /plan). Disabled while the delete is in flight so a double-click
 * can't fire twice.
 */
export function DeletePlanButton({ planId }: { planId: string }) {
  const [pending, setPending] = useState(false);

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
      onClick={onDelete}
      disabled={pending}
      aria-label="remove this plan"
      className="pill pill-action cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <X size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
