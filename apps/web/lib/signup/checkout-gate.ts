/**
 * VIL-558 go-live: Hale never pays and never submits a charged cart.
 *
 * A $0 / free class may be submitted after the parent approved. An unknown
 * total is treated as charged, so the run stops and the parent is told.
 * Saved-card and Link payment stay in the engines for a later arming; this
 * gate is what keeps them off a live cart today.
 */
export function chargedCartMustStop(cartTotalCents: number | null): boolean {
  return cartTotalCents === null || cartTotalCents > 0;
}

/** True only for an explicit $0 total. Null is not free. */
export function freeCartMaySubmit(cartTotalCents: number | null): boolean {
  return cartTotalCents === 0;
}

/**
 * Playwright snapshots list every price on the page. A submit is refused as
 * soon as any of them is above $0, even when that amount matches the approval.
 */
export function chargedPricesMustStop(priceCents: readonly number[]): boolean {
  return priceCents.some((cents) => cents > 0);
}
