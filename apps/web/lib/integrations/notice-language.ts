import { type Database, schema } from '@hale/db';
import { and, eq, gte } from 'drizzle-orm';
import { acceptReplyLanguage } from '~/lib/channel/language';

/**
 * WHICH LANGUAGE AN EMAIL-ALERT NOTICE IS WRITTEN IN: the one the parent actually texts
 * Hale in. The router's inbound screen reads each text's language and stores it on the
 * parent (`users.locale`, `rememberParentLanguage`), so once the parent has texted
 * recently that tag is their language — whatever the family profile says. Only with no
 * recent inbound text is `families.primary_language` used, and then as a hint.
 */
export const NOTICE_LANGUAGE_HISTORY_DAYS = 90;

export function noticeLanguage(input: {
  /** True when the parent has texted Hale within the history window. */
  textedRecently: boolean;
  /** `users.locale`: the language the inbound screen last read from them. */
  parentLocale: string | null;
  /** `families.primary_language`: the profile's hint. */
  familyPrimary: string | null;
}): string {
  const texted = input.textedRecently ? acceptReplyLanguage(input.parentLocale) : null;
  return (
    texted ??
    acceptReplyLanguage(input.familyPrimary) ??
    acceptReplyLanguage(input.parentLocale) ??
    'en'
  );
}

export async function readNoticeLanguage(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<string> {
  const since = new Date(input.now.getTime() - NOTICE_LANGUAGE_HISTORY_DAYS * 86_400_000);
  const [inbound, user, family] = await Promise.all([
    database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.parentUserId, input.parentUserId),
          eq(schema.channelMessages.direction, 'in'),
          gte(schema.channelMessages.createdAt, since),
        ),
      )
      .limit(1),
    database
      .select({ locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, input.parentUserId))
      .limit(1),
    database
      .select({ primaryLanguage: schema.families.primaryLanguage })
      .from(schema.families)
      .where(eq(schema.families.id, input.familyId))
      .limit(1),
  ]);
  return noticeLanguage({
    textedRecently: inbound.length > 0,
    parentLocale: user[0]?.locale ?? null,
    familyPrimary: family[0]?.primaryLanguage ?? null,
  });
}
