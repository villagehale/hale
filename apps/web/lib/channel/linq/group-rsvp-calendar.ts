import { type Database, schema } from '@hale/db';
import { createFamilyEvent } from '~/lib/loop/queries';

/**
 * VIL-102 — put the plan on one yes household's Hale calendar after that
 * household said yes to the write. Google placement is a separate port so a
 * missing connection is a named skip, never a silent no-op (rule #11).
 */

export interface GroupRsvpCalendarWrite {
  familyId: string;
  actorUserId: string | null;
  title: string;
  startsAt: Date;
  location: string | null;
}

export interface GroupRsvpCalendarPort {
  place(input: GroupRsvpCalendarWrite): Promise<{ familyEventId: string } | { skipped: string }>;
}

export function createGroupRsvpCalendarPort(database: Database): GroupRsvpCalendarPort {
  return {
    async place(input) {
      const familyEventId = await createFamilyEvent(database, {
        familyId: input.familyId,
        childId: null,
        title: input.title,
        startsAt: input.startsAt,
        endsAt: null,
        location: input.location,
        source: 'channel',
        createdBy: input.actorUserId,
      });
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.actorUserId ?? 'system',
        actionTaken: 'linq_group_rsvp_calendar_written',
        targetTable: 'family_events',
        targetId: familyEventId,
        after: { source: 'channel' },
      });
      return { familyEventId };
    },
  };
}
