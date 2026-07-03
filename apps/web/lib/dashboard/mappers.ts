import type { schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import type { EntryTone } from '~/components/hale/tone';
import { dayKeyOf, formatDayHeading, formatTime } from '~/lib/format/datetime';
import { targetLink, targetNoun, trailVerb, verbTone } from '~/lib/trail/verbs';

export type AuditLogEntry = typeof schema.auditLog.$inferSelect;

/**
 * Pure row → view-shape mappers for the History (audit trail) page. Kept free of
 * I/O so they're unit-testable in isolation; the page does the querying and passes
 * rows in.
 */

export type TrailActor = 'hale' | 'you' | 'co-parent';

/**
 * Resolves a stored `audit_log.actor` — `'system'`, an agent-run uuid, or a user
 * uuid — to the timeline's actor. Built server-side from the family's member set
 * (queries.ts) and injected so the mapper stays pure. The HARD rule lives in the
 * resolver, not the mapper: only a uuid that MATCHES a family member is a human;
 * `'system'`, an agent-run uuid, and any UNKNOWN uuid all read as Hale — an
 * unknown id is NEVER defaulted to a human (which would misattribute Hale's own
 * work, or a departed user's, to the parent reading the trail).
 */
export type ActorResolver = (actor: string) => TrailActor;

export interface TrailView {
  id: string;
  /** `HH:MM` in the family's zone — the row's time within its day group. */
  time: string;
  /** `Thursday, Jun 11` (year on other-year) — the day-group heading + CSV date. */
  date: string;
  /** `YYYY-MM-DD` in the family's zone — the stable grouping key. */
  dayKey: string;
  tone: EntryTone;
  actor: TrailActor;
  summary: string;
  /** The record's domain noun (`draft`, `plan`, …) — never the raw table name. */
  noun: string;
  /** A deep link to the surface where the record is viewable, or null. */
  link: string | null;
  /** The teen-safe child label, or null for a whole-family / unattributed row. */
  childLabel: string | null;
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

/**
 * Teen-content trail rows (rule #1) keep the non-sensitive frame — time, day,
 * actor, the domain noun, and the deep link — but the SUMMARY is redacted to the
 * placeholder. The verb sentence is Hale's own phrasing, but the row can concern
 * a teen, so it is redacted conservatively whenever the row resolves to
 * teen_content. Rows the query layer cannot tie to teen_content (e.g. non-`actions`
 * targets) keep their sentence — see loadTrail for that join.
 *
 * `timeZone` is the family's zone (loadFamilyTimezone), so the stamps read in the
 * family's clock, not the server's. `resolveActor` maps the stored actor to
 * hale/you/co-parent from the family's member set (an unknown id → hale, never a
 * human). The `now` seam keeps the other-year day heading testable.
 */
export function toTrailView(
  entry: AuditLogEntry,
  teenContent: boolean,
  timeZone: string,
  resolveActor: ActorResolver,
  childLabel: string | null = null,
  now: Date = new Date(),
): TrailView {
  const { sentence, family } = trailVerb(entry.actionTaken);
  return {
    id: entry.id,
    time: formatTime(entry.occurredAt, timeZone),
    date: formatDayHeading(entry.occurredAt, timeZone, now),
    dayKey: dayKeyOf(entry.occurredAt, timeZone),
    tone: verbTone(family),
    actor: resolveActor(entry.actor),
    summary: teenContent ? TEEN_REDACTED_PLACEHOLDER : sentence,
    noun: targetNoun(entry.targetTable),
    link: targetLink(entry.targetTable, entry.targetId),
    childLabel,
  };
}
