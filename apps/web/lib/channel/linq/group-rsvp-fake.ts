import { randomUUID } from 'node:crypto';
import type { GroupRsvpCalendarPort } from './group-rsvp-calendar';
import type { GroupRsvpLineInput } from './group-rsvp-line-input';
import type { GroupRsvpReadInput, GroupRsvpReader, GroupRsvpReading } from './group-rsvp-read';
import type { GroupRsvpComposer } from './group-rsvp-voice';

/**
 * Test and Preview doubles. They do not call a model and they are never the
 * production path. Production stays silent when the reader or composer is missing.
 */

export function fakeGroupRsvpReader(
  script: (input: GroupRsvpReadInput) => GroupRsvpReading | null,
): GroupRsvpReader & { calls: GroupRsvpReadInput[] } {
  const calls: GroupRsvpReadInput[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      return script(input);
    },
  };
}

export function fakeGroupRsvpComposer(): GroupRsvpComposer & { calls: GroupRsvpLineInput[] } {
  const calls: GroupRsvpLineInput[] = [];
  return {
    calls,
    async compose(input) {
      calls.push(input);
      if (!input.facts.send) return { send: false, line: '' };
      const counts = `${input.facts.yes} yes, ${input.facts.no} no, ${input.facts.pending} pending`;
      const title = input.facts.title ?? 'the plan';
      if (input.kind === 'started') {
        const ask = input.questions === 1 ? ' When is it?' : '';
        return { send: true, line: `I'll keep the count for ${title}. ${counts}.${ask}`.trim() };
      }
      if (input.kind === 'calendar_placed' && input.facts.calendarPlacedFor) {
        return {
          send: true,
          line: `${input.facts.calendarPlacedFor} is on the calendar for ${title}. ${counts}.`,
        };
      }
      const ask = input.facts.calendarAskFor
        ? ` ${input.facts.calendarAskFor}, want it on your calendar?`
        : '';
      return { send: true, line: `${counts} for ${title}.${ask}` };
    },
  };
}

export function fakeGroupRsvpCalendar(inner?: GroupRsvpCalendarPort): GroupRsvpCalendarPort & {
  writes: { familyId: string; title: string }[];
} {
  const writes: { familyId: string; title: string }[] = [];
  return {
    writes,
    async place(input) {
      writes.push({ familyId: input.familyId, title: input.title });
      if (inner) return inner.place(input);
      return { familyEventId: randomUUID() };
    },
  };
}
