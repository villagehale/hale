import type { Database } from '@hale/db';
import { declinePrivilegedGroupSeat } from '~/lib/channel/linq/group-members';
import type {
  DeterministicHandler,
  HandlerContext,
  HandlerVerdict,
} from '~/lib/channel/router/route';
import { isExplicitSignupUtterance } from './authorize';
import { AUTHORIZED_SIGNUP_TEMPLATE_KEY } from './copy';
import type { GroupSignupDelivery } from './report';
import { runAuthorizedSignup } from './run';
import type { SignupBrowser } from './types';

export interface AuthorizedSignupHandlerDeps {
  browser?: SignupBrowser | null;
  deliverGroup?: (input: GroupSignupDelivery) => Promise<'sent' | 'failed' | 'already_sent'>;
}

/**
 * Claims an explicit signup sentence ("yes, sign us up") and nothing else.
 *
 * A bare yes stays with the handlers ahead of this one. This handler sits
 * before the registration reader, which also claims messages it cannot read,
 * and before the name capture and the evening check-in.
 */
export function authorizedSignupHandler(
  deps: AuthorizedSignupHandlerDeps = {},
): DeterministicHandler {
  return {
    name: 'authorized_signup',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const directed = ctx.parentIntent?.intent === 'signup';
      if (ctx.parentIntent && !directed) return { claimed: false };
      if (
        (directed || isExplicitSignupUtterance(ctx.body)) &&
        (await declinePrivilegedGroupSeat(database, {
          familyId: ctx.familyId,
          userId: ctx.parentUserId,
          capability: 'signup',
        }))
      ) {
        return { claimed: true, outcome: 'group_member_not_authorized', reply: null };
      }
      const result = await runAuthorizedSignup(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          resolverAuthorized: directed,
          inboundChannelMessageId: ctx.inboundChannelMessageId,
          existingThread: true,
          now: ctx.now,
        },
        deps,
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
