import { type SQL, and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { familyEvents } from './schema/family-events.js';
import { kidRelevanceVerdicts } from './schema/kid-relevance-verdicts.js';

/**
 * A live family_events row the whole household may see: not soft-deleted, and not a
 * mirror of one parent's Google Calendar. A mirror (`google_event_id` set) is Hale's
 * own note for reminding the parent who connected that calendar; only Hale sees both
 * parents' calendars. Every reader that reaches a parent, a feed, an MCP client or
 * the coach uses this.
 */
export function householdFamilyEvent(): SQL {
  return and(isNull(familyEvents.deletedAt), isNull(familyEvents.googleEventId)) as SQL;
}

/**
 * A live family_events row Hale may tell one parent about: the household's rows, plus
 * the mirrors of that parent's own connected Google Calendar (`created_by` is the parent
 * who connected it) that a live `kid` verdict covers, the mirrors the reminder cron
 * reminds that parent of (VIL-548). For a reader whose output reaches that one parent.
 */
export function familyEventForParent(userId: string): SQL {
  return or(
    householdFamilyEvent(),
    and(
      isNull(familyEvents.deletedAt),
      isNotNull(familyEvents.googleEventId),
      eq(familyEvents.createdBy, userId),
      sql`exists (select 1 from ${kidRelevanceVerdicts} where ${kidRelevanceVerdicts.id} = ${familyEvents.kidVerdictId} and ${kidRelevanceVerdicts.verdict} = 'kid')`,
    ),
  ) as SQL;
}

/**
 * A household row that was removed: soft-deleted, and never a mirror. For a reader that
 * must see what was taken off the household's calendar (VIL-581: what backs "I took it
 * off your calendar"); a parent's own Google mirror stays out for the same reason as above.
 */
export function householdRemovedFamilyEvent(): SQL {
  return and(isNotNull(familyEvents.deletedAt), isNull(familyEvents.googleEventId)) as SQL;
}
