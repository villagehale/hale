import type { ReplyLanguage } from '~/lib/channel/language';
import { townLabel } from '~/lib/channel/town-label';
import {
  type SpokenLineComposer,
  type SpokenLineOptions,
  type SpokenLineResult,
  speakLine,
} from '~/lib/channel/voice/spoken-line';
import type {
  EmptySaturdayNudge,
  HealthCheckpointNudge,
  Nudge,
  WeekdayCareAsk,
} from './nudge-decide';
import { type NudgeLineFacts, nudgeLineInput } from './nudge-line-input';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from './shell';

/**
 * VIL-239 · M4 — COMPOSE: the decision object, said out loud in Hale's voice.
 *
 * ONE model call, and it writes only WORDS. Every fact — the town, the open time, the
 * venue, the day, the kids' names, the weather claim — is injected by DECIDE, and the
 * composed message is judged back against those facts before it is allowed near a
 * parent (voice/judge.ts). The model cannot invent a venue Hale never found, because a
 * line carrying one is refused.
 *
 * WHAT CHANGED (VIL-413 / VIL-417, founder rule 2026-10-04): there is no deterministic
 * render underneath these any more. A refused or failed line is retried once on a short
 * prompt; if that fails too, nothing goes out, #ops is paged, and the sweep leaves the
 * family's keys unclaimed for the next tick. An on-time plain sentence used to be the
 * argument for the fallback; the founder's rule is that a templated sentence to a parent
 * is the worse outcome, so the trade is made the other way now.
 *
 * {@link NUDGE_OPT_OUT} is not the model's to write — the judge refuses compliance
 * wording — and the sender no longer appends it (founder decision, 2026-10-01).
 */

// Re-exported so every existing importer keeps its import path: these moved to ./shell
// only to break the cycle between this file and the static health renderer.
export { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT };

/**
 * The nudge kinds a MODEL writes words for. Health-admin checkpoints (VIL-243 · M8)
 * are excluded by construction rather than by a runtime check: their copy is static so
 * a human can review once and know what every family receives, and excluding them from
 * this type means a future voice path cannot quietly start composing them.
 *
 * The two ASKS (VIL-360 weekday care, VIL-365 empty Saturday) are spoken by the
 * proactive-voice skill instead (./proactive-line.ts): this skill forbids questions.
 */
export type VoicedNudge = Exclude<
  Nudge,
  HealthCheckpointNudge | WeekdayCareAsk | EmptySaturdayNudge
>;

/** The two 1:1 asks the model writes through the proactive-voice skill. */
export type SpokenAskNudge = WeekdayCareAsk | EmptySaturdayNudge;

export function isSpokenAskNudge(nudge: Nudge): nudge is SpokenAskNudge {
  return nudge.kind === 'weekday_care' || nudge.kind === 'empty_saturday';
}

export function isVoicedNudge(nudge: Nudge): nudge is VoicedNudge {
  return (
    nudge.kind === 'registration' ||
    nudge.kind === 'weather_swap' ||
    nudge.kind === 'weekday_dropin'
  );
}

/**
 * What the model is handed: the nudge's FACTS, and nothing else. No candidate uuid, no
 * internal municipality token. `kind` rides along because the shapes want different
 * emphasis — a deadline is urgent, a weekend swap is an offer — and the skill needs to
 * know which one it is holding.
 */
export function nudgeVoiceContext(nudge: VoicedNudge): NudgeLineFacts {
  if (nudge.kind === 'registration') {
    return {
      kind: nudge.kind,
      town: townLabel(nudge.windowRef.municipality),
      cycle: nudge.windowRef.cycleLabel,
      opensAtLocal: nudge.opensAtLocal,
      kidNames: nudge.kidNames,
      residentNote: nudge.residentNote,
      ageApproximate: nudge.ageApproximate,
    };
  }
  if (nudge.kind === 'weekday_dropin') {
    // NO TIME OF DAY. The candidate row the decide read carries no clock time (the
    // reader does not select `summary`), so `day` is the only time-shaped fact there
    // is, and the skill's rule is to reuse the one it was given or say nothing.
    return {
      kind: nudge.kind,
      what: nudge.candidateRef.title,
      where: nudge.candidateRef.venueName,
      day: nudge.weekday,
      kidNames: nudge.kidNames,
    };
  }
  return {
    kind: nudge.kind,
    what: nudge.candidateRef.title,
    where: nudge.candidateRef.venueName,
    day: nudge.day,
    kidNames: nudge.kidNames,
    weatherFact: nudge.weatherFact,
    whyFacts: nudge.whyFacts,
  };
}

/**
 * The find, written by the model, or `unsent`. `address` is tu in a parent's own
 * thread and vous when the bubble lands in the household group.
 */
export function speakNudgeLine(
  voice: SpokenLineComposer | undefined,
  nudge: VoicedNudge,
  language: ReplyLanguage,
  address: 'tu' | 'vous',
  options: SpokenLineOptions = {},
): Promise<SpokenLineResult> {
  return speakLine(voice, nudgeLineInput(nudgeVoiceContext(nudge), language, address), options);
}
