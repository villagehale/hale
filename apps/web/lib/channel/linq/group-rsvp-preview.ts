import type { Database } from '@hale/db';
import { takeGroupRsvpTurn } from './group-rsvp';
import type { GroupRsvpCalendarPort } from './group-rsvp-calendar';
import type { GroupRsvpReader } from './group-rsvp-read';
import type { GroupRsvpComposer, GroupRsvpLineSend } from './group-rsvp-voice';

/**
 * VIL-102 Preview play — a 3-family birthday party in one group chat.
 *
 * Fake families only. No Linq send. Hale's lines go through the voice seam
 * the caller injects. Production never uses this script as copy.
 */

export const PREVIEW_PHONES = {
  priya: '+14165550111',
  jordan: '+14165550222',
  sam: '+14165550333',
} as const;

export interface PreviewTurn {
  from: string;
  text: string;
  tapback?: string;
  outcome?: string;
}

export interface PreviewPlay {
  before: { haleLines: string[]; parentLines: string[] };
  after: PreviewTurn[];
  calendarWrites: { familyId: string; title: string }[];
}

const SCRIPT: {
  from: keyof typeof PREVIEW_PHONES;
  name: string;
  text: string;
  tapback?: string;
}[] = [
  {
    from: 'priya',
    name: 'Priya',
    text: "Hale can you keep track of who's coming to Maya's party Saturday at 2 at the park?",
  },
  { from: 'jordan', name: 'Jordan', text: 'anyone bringing chips?' },
  { from: 'jordan', name: 'Jordan', text: "we'll be there" },
  { from: 'jordan', name: 'Jordan', text: 'yes please put it on our calendar' },
  { from: 'sam', name: 'Sam', text: "can't make it, sorry" },
  { from: 'priya', name: 'Priya', text: 'should we do balloons too?' },
  { from: 'priya', name: 'Priya', text: '', tapback: 'like' },
];

export async function playGroupRsvpPreview(
  database: Database,
  ports: {
    chatId: string;
    now: Date;
    reader: GroupRsvpReader;
    voice: GroupRsvpComposer;
    calendar: GroupRsvpCalendarPort & { writes?: { familyId: string; title: string }[] };
  },
): Promise<PreviewPlay> {
  const parentLines = SCRIPT.filter((row) => row.text).map((row) => `${row.name}: ${row.text}`);
  const after: PreviewTurn[] = [];
  const send: GroupRsvpLineSend = async ({ text }) => {
    after.push({ from: 'Hale', text });
    return { providerMessageId: `preview-${after.length}` };
  };

  for (const [index, row] of SCRIPT.entries()) {
    if (row.text) after.push({ from: row.name, text: row.text });
    else if (row.tapback)
      after.push({ from: row.name, text: `(${row.tapback} tapback)`, tapback: row.tapback });
    const result = await takeGroupRsvpTurn(
      database,
      {
        chatId: ports.chatId,
        senderHandle: PREVIEW_PHONES[row.from],
        text: row.text,
        tapback: row.tapback ?? null,
        providerMessageId: `preview-in-${index}`,
        receivedAt: ports.now,
        now: new Date(ports.now.getTime() + index * 1000),
      },
      { reader: ports.reader, voice: ports.voice, calendar: ports.calendar, send },
    );
    if (result.handled) {
      const last = after[after.length - 1];
      if (last) last.outcome = result.outcome;
    }
  }

  return {
    before: { haleLines: [], parentLines },
    after,
    calendarWrites: ports.calendar.writes ?? [],
  };
}
