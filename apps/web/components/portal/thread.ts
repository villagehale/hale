import type { TrailView } from '~/lib/dashboard/mappers';
import { dayKeyOf } from '~/lib/format/datetime';
import type { MessageView } from '~/lib/messages/mappers';
import { dayHeading } from './format';
import type { ThreadItem } from './messages-board';

export function zoneDayKeys(
  timeZone: string,
  now = new Date(),
): { today: string; yesterday: string } {
  const today = dayKeyOf(now, timeZone);
  const yesterday = dayKeyOf(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone);
  return { today, yesterday };
}

function actionIdOf(note: MessageView): string | null {
  if (note.kind !== 'action' || !note.id.startsWith('action-')) return null;
  return note.id.slice('action-'.length);
}

/**
 * Trail rows are the record of what happened. Message notes that name the same
 * action are dropped so a draft doesn't appear twice. Newest first.
 */
export function buildThreadItems(
  trail: TrailView[],
  messages: MessageView[],
  todayKey: string,
  yesterdayKey: string,
): ThreadItem[] {
  const seen = new Set(trail.map((row) => row.actionId).filter((id): id is string => id !== null));
  const fromTrail: ThreadItem[] = trail.map((row) => {
    const hale = row.actor === 'hale';
    return {
      id: row.id,
      day: dayHeading(row.dayKey, todayKey, yesterdayKey),
      time: row.time,
      kind: hale ? 'did' : 'out',
      text: hale && row.time ? `${row.summary} · ${row.time}` : row.summary,
      hale,
    };
  });
  const fromMessages: ThreadItem[] = [];
  for (const note of messages) {
    if (note.actionState === 'drafted_for_approval') continue;
    const actionId = actionIdOf(note);
    if (actionId && seen.has(actionId)) continue;
    const hale = note.actionState === 'autonomous';
    fromMessages.push({
      id: note.id,
      day: note.today ? 'Today' : note.when,
      time: '',
      kind: hale ? 'did' : note.actionState === 'reverted' ? 'out' : 'in',
      text: note.body,
      hale,
    });
  }
  return [...fromTrail, ...fromMessages];
}
