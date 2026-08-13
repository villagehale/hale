import type { HealthCheckpointNudge } from '~/lib/channel/nudge/nudge-decide';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
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
 * The close for a checkpoint whose task IS booking a visit. It offers to put the
 * job on the family's week — which is what approving actually executes
 * (add_to_routine) — because Hale does not book, and a close that implied
 * otherwise would be the copy writing a cheque rule #4 refuses to cash.
 */
export const HEALTH_CLOSE_BOOKING = 'Done, or want me to add booking it to your week?';

/** Local, matching the convention in radar-voice/nudge-voice, which each keep their
 * own. Importing one of theirs would make copy and voice mutually dependent. */
function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The most names a subject may carry, and the longest one it may carry. */
const MAX_SUBJECT_NAMES = 3;
const MAX_NAME_CHARS = 16;

/**
 * The names this subject may actually spend budget on.
 *
 * A kid name here is free text an LLM lifted from a stranger's SMS: no length bound, no
 * character restriction, any script. The rest of this message is fixed and already
 * spends both segments, and ONE character outside GSM-7 flips the whole SMS to UCS-2
 * and halves the budget (sms-segments.ts).
 *
 * Which characters those are is not guessable, so it is measured rather than assumed:
 * GSM 03.38 carries "Chloé" and "Zoä" for one septet each but has no ë, ç or â, and no
 * script beyond Latin at all — so "Zoë", "François" and any name in Chinese, Arabic or
 * Devanagari would each cost this message a segment it does not have. Toronto has all
 * of them.
 *
 * A name that would blow the budget is DROPPED rather than allowed to truncate the
 * task: the administrative window is the payload, the roll call is the courtesy, and
 * losing the courtesy is the cheaper failure. When every name is dropped the message
 * simply renders without a subject, which is a shape the lint already covers.
 */
function affordableNames(names: readonly string[]): string[] {
  return names
    .filter((name) => name.length <= MAX_NAME_CHARS && smsEncoding(name) === 'gsm7')
    .slice(0, MAX_SUBJECT_NAMES);
}

/** Who the message opens on, given the names it has been allowed to keep. */
function subjectFor(nudge: HealthCheckpointNudge, names: readonly string[]): string {
  if (nudge.teenOnly) return nudge.teenCount > 1 ? 'Your teens:' : 'Your teen:';
  if (names.length > 0) return `${joinNames(names)}:`;
  return '';
}

/** Whether this body still fits once the shell's opt-out is appended. */
function withinBudget(body: string): boolean {
  return smsSegments(`${body}\n\n${NUDGE_OPT_OUT}`) <= MAX_NUDGE_SEGMENTS;
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

  const assemble = (names: readonly string[]): string => {
    const parts = nudge.teenOnly
      ? [subjectFor(nudge, names), checkpoint.teenSafeTask]
      : [subjectFor(nudge, names), checkpoint.task, checkpoint.detail];
    parts.push(checkpoint.linkUrl, checkpoint.booking ? HEALTH_CLOSE_BOOKING : HEALTH_CLOSE);
    return parts
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ');
  };

  // Drop one name at a time until the whole payload fits. Per-name filtering alone is
  // not enough — three individually affordable names still overflow the two rows whose
  // task runs long — and the message that matters is the ASSEMBLED one, so that is what
  // is measured. The task always survives; only the roll call is negotiable.
  const names = affordableNames(nudge.kidNames);
  for (let kept = names.length; kept > 0; kept -= 1) {
    const body = assemble(names.slice(0, kept));
    if (withinBudget(body)) return body;
  }
  return assemble([]);
}
