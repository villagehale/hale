import { type SQL, and, isNull } from 'drizzle-orm';
import { familyEvents } from './schema/family-events.js';

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
