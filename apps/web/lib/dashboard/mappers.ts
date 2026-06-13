import type { schema } from '@haru/db';
import type { AutonomyLevel } from '~/components/haru/streak-ladder';
import type { EntryTone } from '~/components/haru/tone';

export type Action = typeof schema.actions.$inferSelect;
export type AuditLogEntry = typeof schema.auditLog.$inferSelect;

/**
 * Pure row → view-shape mappers for the three read-only dashboard pages. Kept
 * free of I/O so they're unit-testable in isolation; the pages do the querying
 * and pass rows in. The view shapes mirror what the Meadow markup already
 * renders — only the data source changes, not the look.
 */

export interface DraftView {
  id: string;
  recipient: string;
  category: string;
  subject: string;
  body: string;
  rationale: string;
}

export interface DigestTally {
  handled: number;
  awaiting: number;
  needsYou: number;
}

export interface DigestEntryView {
  id: string;
  tone: EntryTone;
  category: string;
  body: string;
}

export interface TrailView {
  id: string;
  time: string;
  category: string;
  tone: EntryTone;
  actor: 'haru' | 'you' | 'co-parent';
  summary: string;
  detail: string;
}

/** A drafted action's recipient lives in its payload; fall back to the action type. */
function recipientFromPayload(payload: Record<string, unknown>): string {
  const to = payload.recipient ?? payload.to;
  return typeof to === 'string' && to.length > 0 ? to : 'unspecified recipient';
}

function stringFromPayload(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function toDraftView(action: Action): DraftView {
  const payload = action.payload;
  return {
    id: action.id,
    recipient: recipientFromPayload(payload),
    category: action.actionType,
    subject: stringFromPayload(payload, 'subject', action.actionType),
    body: stringFromPayload(payload, 'body', ''),
    rationale: stringFromPayload(payload, 'rationale', ''),
  };
}

/**
 * Folds a day's actions into the digest's three tallies, keyed by the
 * user-visible state the page already frames ("things on the table"):
 *   autonomous            → i handled
 *   drafted_for_approval  → awaiting you
 *   needs_human           → needs you
 * 'reverted' rows are excluded — they're undone, not on today's table.
 */
export function toDigestTally(actions: Pick<Action, 'userVisibleState'>[]): DigestTally {
  const tally: DigestTally = { handled: 0, awaiting: 0, needsYou: 0 };
  for (const action of actions) {
    if (action.userVisibleState === 'autonomous') tally.handled += 1;
    else if (action.userVisibleState === 'drafted_for_approval') tally.awaiting += 1;
    else if (action.userVisibleState === 'needs_human') tally.needsYou += 1;
  }
  return tally;
}

const STATE_TONE: Record<Action['userVisibleState'], EntryTone | null> = {
  autonomous: 'done',
  drafted_for_approval: 'awaiting',
  needs_human: 'needs-you',
  reverted: null,
};

/** Maps a today action to a digest entry. Reverted rows return null — they're
 * off the table and excluded by the caller. Body comes from the action payload;
 * empty bodies fall back to a one-line "what + state" summary. */
export function toDigestEntry(action: Action): DigestEntryView | null {
  const tone = STATE_TONE[action.userVisibleState];
  if (!tone) return null;
  const body = stringFromPayload(action.payload, 'body', '');
  return {
    id: action.id,
    tone,
    category: action.actionType,
    body: body.length > 0 ? body : `${action.actionType} · ${action.userVisibleState}`,
  };
}

/** audit_log.actor is 'system' | agent_run uuid | user uuid; the timeline only
 * distinguishes haru vs. a parent. A non-system actor is a human ("you"); the
 * co-parent distinction needs the acting user's role, which the audit row alone
 * doesn't carry — so human actors read as "you" until that join is wired. */
function actorOf(entry: AuditLogEntry): TrailView['actor'] {
  return entry.actor === 'system' ? 'haru' : 'you';
}

const HH_MM = new Intl.DateTimeFormat('en-CA', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Toronto',
});

export function toTrailView(entry: AuditLogEntry): TrailView {
  return {
    id: entry.id,
    time: HH_MM.format(entry.occurredAt),
    category: entry.targetTable ?? 'action',
    tone: 'done',
    actor: actorOf(entry),
    summary: entry.actionTaken,
    detail: entry.targetId ? `${entry.targetTable ?? 'record'} · ${entry.targetId}` : 'recorded',
  };
}

export const DRAFT_LEVEL: AutonomyLevel = 2;
