import type { HealthCheckpointNudge } from '~/lib/channel/nudge/nudge-decide';
import { checkpointById } from './checkpoints';

/**
 * VIL-243 · M8 — the health nudge, rendered. STATIC TEMPLATES, no model, deliberately.
 *
 * Every other nudge class in F14 lets a model write the words around facts the decider
 * emitted, because warmth is worth a small fabrication risk on a weekend suggestion.
 * Health-admin copy is the one place where that trade inverts. This message is the one
 * a parent might act on without reading twice, it is the one where a single invented
 * clause ("she's a bit behind") is a diagnosis Hale has no standing to make, and it is
 * the one that has to be reviewable by a human who is not watching a model: a static
 * template is copy a founder can read once and know what every family will receive.
 *
 * So the message is assembled from the reviewed table and three constants, and the lint
 * in framing.ts runs over the ASSEMBLED result — a template that produced a banned
 * phrase by joining two innocent halves would still fail.
 *
 * ONE shape, three subjects:
 *
 *   Maya and Noah: <task> <detail> <link> <close>
 *   Your teens:    <teen-safe task>   <link> <close>
 *                  <task> <detail>    <link> <close>     (nobody was named)
 *
 * The teen variant drops `detail` entirely rather than checking whether this row's
 * detail happens to be safe — fail-closed beats fail-careful (rule #1).
 */

/** The ONE close. Reply-able, and it names the two things a parent can actually say. */
export const HEALTH_CLOSE = 'Done, or want a reminder next week?';

/**
 * The close for a checkpoint whose task IS booking a visit. It offers a DRAFT and says
 * so: Hale does not book, and a close that implied otherwise would be the copy writing
 * a cheque rule #4 refuses to cash.
 */
export const HEALTH_CLOSE_BOOKING = 'Done, or want me to draft a booking for you to approve?';

/** Local, matching the convention in radar-voice/nudge-voice, which each keep their
 * own. Importing one of theirs would make copy and voice mutually dependent. */
function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Who the message opens on, or '' when there is nobody Hale may name. */
function subjectFor(nudge: HealthCheckpointNudge): string {
  if (nudge.teenOnly) return nudge.teenCount > 1 ? 'Your teens:' : 'Your teen:';
  if (nudge.kidNames.length > 0) return `${joinNames(nudge.kidNames)}:`;
  return '';
}

/**
 * The message body, WITHOUT the CASL opt-out — the sender appends that exactly once,
 * the same shell every proactive class shares (see nudge-voice.ts).
 *
 * Plain ASCII throughout: one typographic dash would flip the whole SMS to UCS-2 and
 * halve the character budget (sms-segments.ts). framing.test.ts holds that line.
 */
export function renderHealthNudge(nudge: HealthCheckpointNudge): string {
  const checkpoint = checkpointById(nudge.checkpointRef.id);
  if (!checkpoint) {
    throw new Error(`renderHealthNudge: no checkpoint '${nudge.checkpointRef.id}'`);
  }

  if (nudge.teenOnly && checkpoint.teenSafeTask === null) {
    // The matcher refuses to emit this, so reaching it means the two sides disagree —
    // and the safe reaction to that is to send nothing, not to fall back to the
    // specific wording (rule #1).
    throw new Error(`renderHealthNudge: '${checkpoint.id}' has no teen-safe wording`);
  }

  const parts = nudge.teenOnly
    ? [subjectFor(nudge), checkpoint.teenSafeTask]
    : [subjectFor(nudge), checkpoint.task, checkpoint.detail];

  parts.push(checkpoint.linkUrl, checkpoint.booking ? HEALTH_CLOSE_BOOKING : HEALTH_CLOSE);
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}
