import type { TrailEntry } from '../components/hale/activity-trail';
import type { ConversationSummary } from './api-types';
import type { ActionIntent, ActivityEvent } from './coach-api';

/**
 * Pure logic for the Ask history sheet: bucket the family's conversations into
 * Today / Earlier off the device's LOCAL day, label each row's timestamp, and
 * rehydrate a reopened transcript into the Ask screen's message shapes. Kept free of
 * React/RN so it is unit-tested directly. `now` is injected so the day boundary is
 * deterministic in tests.
 */

/** A restored user turn — a plain right-aligned bubble. */
export interface HistoryUserMessage {
  id: string;
  role: 'user';
  text: string;
}

/** A restored Hale turn — a completed, non-streaming plain-text answer. Historical
 * turns carry no live tool/stream metadata, so the trail/activity/intents are empty
 * and the turn renders as a settled simple answer. Structurally a subset of the Ask
 * screen's HaleTurn, so it drops straight into its message list. */
export interface HistoryHaleMessage {
  id: string;
  role: 'hale';
  text: string;
  trail: TrailEntry[];
  activity: ActivityEvent[];
  actionIntents: ActionIntent[];
  streaming: false;
  errored: false;
}

export type HistoryMessage = HistoryUserMessage | HistoryHaleMessage;

/** The minimal transcript-turn shape the mapper reads. Deliberately broader than the
 * API's `'user' | 'assistant'` union so an unexpected role is skipped, not rendered. */
export interface TranscriptTurn {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface GroupedConversations {
  today: ConversationSummary[];
  earlier: ConversationSummary[];
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Buckets conversations into Today (same local day as `now`) and Earlier. Input
 * order is preserved within each group — the list arrives newest-active first from
 * the server, and that ordering carries through.
 */
export function groupConversations(
  conversations: readonly ConversationSummary[],
  now: Date,
): GroupedConversations {
  const today: ConversationSummary[] = [];
  const earlier: ConversationSummary[] = [];
  for (const conversation of conversations) {
    if (isSameLocalDay(new Date(conversation.lastMessageAt), now)) today.push(conversation);
    else earlier.push(conversation);
  }
  return { today, earlier };
}

/**
 * The row sub line: a 12-hour clock ("5:12 PM") for a conversation last active today,
 * else a "Mon D" date ("Jul 14"). No category is shown — the list endpoint carries
 * none (spec Feature 3 honesty note).
 */
export function formatSessionTime(lastMessageAt: string, now: Date): string {
  const at = new Date(lastMessageAt);
  if (isSameLocalDay(at, now)) {
    const minutes = at.getMinutes().toString().padStart(2, '0');
    const hour24 = at.getHours();
    const meridiem = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}:${minutes} ${meridiem}`;
  }
  return `${MONTH_ABBR[at.getMonth()]} ${at.getDate()}`;
}

/**
 * Whether a failed cold-start restore should forget the stored conversation id. Only a
 * 404 is permanent — the conversation is gone, or belongs to another family and reads
 * as not-found (rule #1). Every other failure (offline, timeout, 5xx) is transient, so
 * the id is kept and the next cold start retries it instead of silently dropping the
 * thread. A 401 never reaches here — the api client bounces to sign-in first.
 */
export function shouldForgetConversationOnRestore(status: number): boolean {
  return status === 404;
}

/**
 * Maps a reopened conversation's transcript into the Ask screen's message list:
 * user turns become user bubbles, assistant turns become completed Hale turns, and
 * any other role is skipped. Order is preserved.
 */
export function transcriptToMessages(turns: readonly TranscriptTurn[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ id: turn.id, role: 'user', text: turn.content });
    } else if (turn.role === 'assistant') {
      messages.push({
        id: turn.id,
        role: 'hale',
        text: turn.content,
        trail: [],
        activity: [],
        actionIntents: [],
        streaming: false,
        errored: false,
      });
    }
  }
  return messages;
}
