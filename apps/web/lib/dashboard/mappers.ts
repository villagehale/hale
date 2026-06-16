import type { schema } from '@hale/db';
import type { AutonomyLevel } from '~/components/hale/streak-ladder';
import type { EntryTone } from '~/components/hale/tone';

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
  actor: 'hale' | 'you' | 'co-parent';
  summary: string;
  detail: string;
}

/**
 * Hard rule #1 (teen privacy): for children 13+, a parent sees category +
 * Hale's own rationale-summary + this placeholder — never the teen's raw
 * subject/body/quoted text. The parent still approves on category + summary (the
 * L2 model: authorize "reply to the school about X" without reading the teen's
 * message). `teenContent` is an EXPLICIT mapper input so the redaction is
 * structural: a caller that forgets to JOIN events still cannot leak raw teen
 * text once the flag is true, because the raw fields never reach the view shape.
 */
export const TEEN_REDACTED_PLACEHOLDER = 'kept private — regarding your teenager';

/** A drafted action's recipient lives in its payload; fall back to the action type. */
function recipientFromPayload(payload: Record<string, unknown>): string {
  const to = payload.recipient ?? payload.to;
  return typeof to === 'string' && to.length > 0 ? to : 'unspecified recipient';
}

function stringFromPayload(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function toDraftView(action: Action, teenContent: boolean): DraftView {
  const payload = action.payload;
  return {
    id: action.id,
    recipient: recipientFromPayload(payload),
    category: action.actionType,
    subject: teenContent ? TEEN_REDACTED_PLACEHOLDER : stringFromPayload(payload, 'subject', action.actionType),
    body: teenContent ? TEEN_REDACTED_PLACEHOLDER : stringFromPayload(payload, 'body', ''),
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
 * empty bodies fall back to a one-line "what + state" summary. Teen-content rows
 * (rule #1) keep category + tone but the raw body becomes the redaction
 * placeholder — the parent sees that something happened, in which category,
 * without the teen's words. */
export function toDigestEntry(action: Action, teenContent: boolean): DigestEntryView | null {
  const tone = STATE_TONE[action.userVisibleState];
  if (!tone) return null;
  if (teenContent) {
    return { id: action.id, tone, category: action.actionType, body: TEEN_REDACTED_PLACEHOLDER };
  }
  const body = stringFromPayload(action.payload, 'body', '');
  return {
    id: action.id,
    tone,
    category: action.actionType,
    body: body.length > 0 ? body : `${action.actionType} · ${action.userVisibleState}`,
  };
}

/** audit_log.actor is 'system' | agent_run uuid | user uuid; the timeline only
 * distinguishes Hale vs. a parent. A non-system actor is a human ("you"); the
 * co-parent distinction needs the acting user's role, which the audit row alone
 * doesn't carry — so human actors read as "you" until that join is wired. */
function actorOf(entry: AuditLogEntry): TrailView['actor'] {
  return entry.actor === 'system' ? 'hale' : 'you';
}

const HH_MM = new Intl.DateTimeFormat('en-CA', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Toronto',
});

/**
 * Teen-content trail rows (rule #1) keep the non-sensitive frame — time, category
 * (target_table), actor, and the id-only detail — but `actionTaken` is redacted to
 * the placeholder. `actionTaken` is Hale's own phrasing, but it can quote the
 * teen (e.g. an email subject), so it is redacted conservatively whenever the row
 * resolves to teen_content. Rows the query layer cannot tie to teen_content (e.g.
 * non-`actions` targets) keep their summary — see loadTrail for that join.
 */
export function toTrailView(entry: AuditLogEntry, teenContent: boolean): TrailView {
  return {
    id: entry.id,
    time: HH_MM.format(entry.occurredAt),
    category: entry.targetTable ?? 'action',
    tone: 'done',
    actor: actorOf(entry),
    summary: teenContent ? TEEN_REDACTED_PLACEHOLDER : entry.actionTaken,
    detail: entry.targetId ? `${entry.targetTable ?? 'record'} · ${entry.targetId}` : 'recorded',
  };
}

export const DRAFT_LEVEL: AutonomyLevel = 2;
