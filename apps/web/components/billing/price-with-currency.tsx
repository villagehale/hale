import type { BillingCurrency } from '@hale/types';

/** Price amount plus a small CAD/USD note. Amount is already a plain `$` label. */
export function PriceWithCurrency({
  amount,
  currency,
  noteClassName,
  after,
}: {
  amount: string;
  currency: BillingCurrency;
  noteClassName?: string;
  after?: string;
}) {
  return (
    <>
      {amount} <span className={noteClassName}>{currency}</span>
      {after}
    </>
  );
}
