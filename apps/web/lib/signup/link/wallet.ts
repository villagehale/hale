import type { Database } from '@hale/db';
import { LinkApiError, type LinkOAuthApi, type LinkWalletApi } from './client';
import { LINK_AGENTIC_SCOPE, loadLinkWallet, rotateLinkRefreshToken } from './vault';

/** Minutes the parent has to approve in Link before the checkout link goes to them. */
export const LINK_APPROVAL_WINDOW_MINUTES = 5;

/**
 * The parent's own Stripe Link Agent Wallet, bound to a fresh access token.
 * A spend request for the exact total is approved by the parent with Face ID
 * or a passkey in Link, which then issues a one-time card.
 */
export interface SignupPaymentWallet {
  kind: 'stripe_link_agent_wallet';
  approvalWindowMinutes: number;
  api: LinkWalletApi;
}

export type SignupWalletSkipped = 'not_linked' | 'missing_scope' | 'token_refresh_failed';

export type SignupWalletLookup =
  | { wallet: SignupPaymentWallet; skipped: null }
  | { wallet: null; skipped: SignupWalletSkipped };

export interface SignupWalletSource {
  forParent(input: {
    familyId: string;
    parentUserId: string;
    now: Date;
  }): Promise<SignupWalletLookup>;
}

/** One wallet per parent. There is no shared or project-level fallback. */
export function linkWalletSource(
  database: Database,
  deps: { oauth: LinkOAuthApi; walletApi: (accessToken: string) => LinkWalletApi },
): SignupWalletSource {
  return {
    async forParent(input) {
      const stored = await loadLinkWallet(database, input);
      if (!stored) return { wallet: null, skipped: 'not_linked' };
      if (!stored.scope.split(/[\s,]+/).includes(LINK_AGENTIC_SCOPE)) {
        return { wallet: null, skipped: 'missing_scope' };
      }
      let tokens: Awaited<ReturnType<LinkOAuthApi['refresh']>>;
      try {
        tokens = await deps.oauth.refresh(stored.refreshToken);
      } catch (error) {
        if (error instanceof LinkApiError) return { wallet: null, skipped: 'token_refresh_failed' };
        throw error;
      }
      await rotateLinkRefreshToken(database, {
        id: stored.id,
        refreshToken: tokens.refreshToken,
        refreshedAt: input.now,
      });
      return {
        wallet: {
          kind: 'stripe_link_agent_wallet',
          approvalWindowMinutes: LINK_APPROVAL_WINDOW_MINUTES,
          api: deps.walletApi(tokens.accessToken),
        },
        skipped: null,
      };
    },
  };
}
