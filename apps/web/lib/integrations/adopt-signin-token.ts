import { channelSigninTokenBelongsToUser } from '~/lib/auth/channel-signin';
import type { db } from '~/lib/db';

/**
 * Shared by the two consent doors a texted link can open: one connector's
 * (api/integrations/[provider]/connect) and VIL-721's one link for Gmail and the
 * calendar together (api/integrations/google/connect). Moved here unchanged from the
 * first, because a route file may export only its handlers.
 */
const SIGNIN_TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Redeem tap carried the token id so consent can burn that link and not its
 * sibling. A miss is named and the consent still starts: an unreadable id must
 * not trap the parent on a page that already signed them in.
 */
export async function adoptSigninToken(
  database: ReturnType<typeof db>,
  input: { familyId: string; userId: string; provider: string; link: string | null },
): Promise<string | undefined> {
  if (!input.link || !SIGNIN_TOKEN_ID.test(input.link)) return undefined;
  try {
    const owned = await channelSigninTokenBelongsToUser(database, {
      tokenId: input.link,
      userId: input.userId,
    });
    if (!owned) {
      console.info(
        { familyId: input.familyId, provider: input.provider },
        'connector consent: sign-in token not attached',
      );
      return undefined;
    }
    return input.link;
  } catch (err) {
    console.info(
      {
        familyId: input.familyId,
        provider: input.provider,
        code: err instanceof Error ? err.name : 'unknown',
      },
      'connector consent: sign-in token unread',
    );
    return undefined;
  }
}
