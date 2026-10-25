import type { Database } from '@hale/db';
import { declinePrivilegedGroupSeat } from '~/lib/channel/linq/group-members';
import type {
  DeterministicHandler,
  HandlerContext,
  HandlerVerdict,
} from '~/lib/channel/router/route';
import { AUTHORIZED_SIGNUP_TEMPLATE_KEY } from './copy';
import type { GroupSignupDelivery } from './report';
import { type SignupRunDeps, runAuthorizedSignup } from './run';
import type { SignupBrowser } from './types';

export interface AuthorizedSignupHandlerDeps
  extends Pick<SignupRunDeps, 'consentReader' | 'outcomeWriter'> {
  browser?: SignupBrowser | null;
  deliverGroup?: (input: GroupSignupDelivery) => Promise<'sent' | 'failed' | 'already_sent'>;
}

/**
 * Claims a reply to a pending sign-up offer when the consent model reads it as
 * consent, a refusal, or unclear (with a clarifying question). Anything else,
 * or an unreadable read, stays with the handlers after this one. This handler sits
 * before the registration reader, which also claims messages it cannot read,
 * and before the name capture and the evening check-in.
 */
export function authorizedSignupHandler(
  deps: AuthorizedSignupHandlerDeps = {},
): DeterministicHandler {
  return {
    name: 'authorized_signup',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const result = await runAuthorizedSignup(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          inboundChannelMessageId: ctx.inboundChannelMessageId,
          existingThread: true,
          now: ctx.now,
        },
        {
          ...deps,
          declineSeat: () =>
            declinePrivilegedGroupSeat(database, {
              familyId: ctx.familyId,
              userId: ctx.parentUserId,
              capability: 'signup',
            }),
        },
      );
      if (!result.claimed) return { claimed: false };
      return {
        claimed: true,
        outcome: result.outcome,
        reply: result.deliverOnThread ? result.reply : null,
        templateKey: AUTHORIZED_SIGNUP_TEMPLATE_KEY,
      };
    },
  };
}
