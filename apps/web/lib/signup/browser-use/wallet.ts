import type { BrowserUseApi } from './client';

/** Minutes the parent has to approve in Link before the checkout link goes to them. */
export const LINK_APPROVAL_WINDOW_MINUTES = 5;

/**
 * A wallet the agent may pay with at checkout. Stripe Link issues a one-time
 * card for the exact total and the parent approves it with Face ID or a
 * passkey in Link. Card numbers never reach Hale, the task or the audit.
 */
export interface SignupPaymentWallet {
  kind: 'stripe_link';
  connectionId: string;
  approvalWindowMinutes: number;
}

export type SignupWalletLookup =
  | { wallet: SignupPaymentWallet; skipped: null }
  | { wallet: null; skipped: 'not_connected' };

export interface SignupWalletSource {
  forFamily(familyId: string): Promise<SignupWalletLookup>;
}

/**
 * Browser Use's Stripe Link wallet. Browser Use holds one Link connection per
 * project, so every family resolves to the same connection today. A
 * per-parent Link account needs a per-family source before payment goes on.
 */
export function browserUseStripeLinkWallet(
  api: Pick<BrowserUseApi, 'getStripeLink'>,
): SignupWalletSource {
  return {
    async forFamily() {
      const link = await api.getStripeLink();
      if (!link.isConnected || !link.connectionId)
        return { wallet: null, skipped: 'not_connected' };
      return {
        wallet: {
          kind: 'stripe_link',
          connectionId: link.connectionId,
          approvalWindowMinutes: LINK_APPROVAL_WINDOW_MINUTES,
        },
        skipped: null,
      };
    },
  };
}
