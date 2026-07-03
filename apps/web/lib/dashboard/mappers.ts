import type { schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import type { EntryTone } from '~/components/hale/tone';
import { formatTime } from '~/lib/format/datetime';

export type AuditLogEntry = typeof schema.auditLog.$inferSelect;

/**
 * Pure row → view-shape mappers for the History (audit trail) page. Kept free of
 * I/O so they're unit-testable in isolation; the page does the querying and passes
 * rows in.
 */

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
 * subject/body/quoted text. `teenContent` is an EXPLICIT mapper input so the
 * redaction is structural: a caller that forgets to JOIN events still cannot leak
 * raw teen text once the flag is true, because the raw fields never reach the view
 * shape. (Also imported by the village mappers for the same purpose.)
 */
export const TEEN_REDACTED_PLACEHOLDER = 'kept private — regarding your teenager';

/**
 * Rule #1 defense-in-depth: the effective teen flag the surface mappers redact on.
 * The stored events.teen_content is a probabilistic classifier signal (a classify
 * miss can leave it false); the concerns-child's live DOB is the source of truth for
 * "is this a teen" (deriveStage boundary 156mo). These are OR'd so a stored-flag miss
 * still redacts a 13+ child's content.
 *
 * `dateOfBirth` is null when the row has no resolvable concerns-child (a family-wide
 * / ambiguous event the classifier didn't attribute). The DOUBLE-MISS — stored flag
 * false AND no DOB — would otherwise fall back to the failed flag and leak; so when
 * there is no DOB to derive from, we fall back to the FAMILY: redact if the family
 * has any teenager (`familyHasTeen`), the rule-#1 "most restrictive" default. A
 * family with no teen is never over-redacted. Pure, no I/O.
 */
export function effectiveTeenContent(
  storedFlag: boolean,
  dateOfBirth: string | null,
  familyHasTeen: boolean,
  now: Date = new Date(),
): boolean {
  if (storedFlag) return true;
  if (dateOfBirth !== null) return deriveStage(dateOfBirth, now) === 'teenager';
  return familyHasTeen;
}

/** audit_log.actor is 'system' | agent_run uuid | user uuid; the timeline only
 * distinguishes Hale vs. a parent. A non-system actor is a human ("you"); the
 * co-parent distinction needs the acting user's role, which the audit row alone
 * doesn't carry — so human actors read as "you" until that join is wired. */
function actorOf(entry: AuditLogEntry): TrailView['actor'] {
  return entry.actor === 'system' ? 'hale' : 'you';
}

/**
 * Teen-content trail rows (rule #1) keep the non-sensitive frame — time, category
 * (target_table), actor, and the id-only detail — but `actionTaken` is redacted to
 * the placeholder. `actionTaken` is Hale's own phrasing, but it can quote the
 * teen (e.g. an email subject), so it is redacted conservatively whenever the row
 * resolves to teen_content. Rows the query layer cannot tie to teen_content (e.g.
 * non-`actions` targets) keep their summary — see loadTrail for that join.
 *
 * `timeZone` is the family's zone (loadFamilyTimezone), so the time-stamp reads in
 * the family's clock, not the server's.
 */
export function toTrailView(
  entry: AuditLogEntry,
  teenContent: boolean,
  timeZone: string,
): TrailView {
  return {
    id: entry.id,
    time: formatTime(entry.occurredAt, timeZone),
    category: entry.targetTable ?? 'action',
    tone: 'done',
    actor: actorOf(entry),
    summary: teenContent ? TEEN_REDACTED_PLACEHOLDER : entry.actionTaken,
    detail: entry.targetId ? `${entry.targetTable ?? 'record'} · ${entry.targetId}` : 'recorded',
  };
}
