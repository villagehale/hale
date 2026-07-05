import type { FamilyStage } from '@hale/types';

// Server-safe core for the child-scope selector: the pure derivations + shared
// types. These MUST NOT live in the 'use client' component file — a function
// exported from a client module becomes a client reference, and a server
// component (Home, Village, Plan, companion logs) that calls it throws at
// runtime ("Attempted to call scopeChildren() from the server"). Keeping the
// pure parts here lets both server callers and the client components import them.

export interface ScopeChild {
  id: string;
  /** Given name, or null when the child has no name on file (renders "your teen"). */
  label: string | null;
}

/** The minimal per-child shape every scope-bearing page already loads. */
export interface StagedChild {
  id: string;
  name: string | null;
  stage: FamilyStage;
}

export type ChildScopeVariant = 'filter' | 'tabs' | 'select';

/**
 * The single derivation of a page's `ScopeChild[]` from its loaded children.
 *
 * Policy 1: the chip shows the child's NAME — the parent entered it, and two teens
 * must never both read the anonymous "your teen" (a scope chip disambiguates WHICH
 * child, so the name is exactly what the parent needs there). This is the chip
 * LABEL only; a 13+ teen's CONTENT stays redacted at its own surfaces (the drop /
 * placeholder / locked-card paths), age-derived via deriveStage — never here.
 *
 * `label` is null only when the child genuinely has no name on file; ChildScope
 * then falls back to "your teen" at render. Order is preserved. Every scope-bearing
 * surface (Home, Village, Approvals, Plan) derives its chips through this one
 * function so the label rule lives in exactly one place.
 */
export function scopeChildren(children: readonly StagedChild[]): ScopeChild[] {
  return children.map((child) => ({
    id: child.id,
    label: child.name,
  }));
}

/**
 * The ordered option values every variant renders and hands to `onChange` by
 * index: whole-family (null) always first, then each child in order. Exported so
 * the "whole-family first / onChange value" contract is unit-testable without a
 * DOM.
 */
export function optionValues(children: ScopeChild[]): Array<string | null> {
  return [null, ...children.map((c) => c.id)];
}
