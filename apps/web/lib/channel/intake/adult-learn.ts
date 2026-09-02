import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { recMorningReturnLine } from '~/lib/channel/rec-morning/copy';
import { townLabel } from './radar-voice';

const INTAKE_MAX_REPLY_CHARS = 300;

/**
 * VIL-323 Designer lock 2026-08-27 — English adult-learn door. A model does not write this.
 * Hyphens, not em dashes. Never "I don't do that."
 *
 * 2026-08-28 (ads-week audit): the CITY is a slot, not a word of the lock. The line
 * shipped with "Brampton" baked in and every session in the province heard it; the
 * surrounding locked words are byte-identical (adult-learn.test.ts pins the Brampton
 * rendering against the original sentence), and the slot carries the session's own
 * resolved city — or "your area", because the wrong city is worse than no city. Both
 * fills are plain ASCII, so the GSM-7 budget holds for every covered municipality.
 */
export function adultLearnDoor(city: string | null): string {
  return `I'm a kids' rec helper, not adult lessons. If you've got kids, send their names and ages and I'll watch ${city ?? 'your area'} for them. If it's just you, no hard feelings.`;
}

/** The slot's value for this session: its FSA's town, only when the FSA resolves to
 * exactly ONE covered municipality (the resident-head-start rule's own conservatism —
 * L4J straddles Vaughan and Markham, and picking either would be a guess). */
function sessionCity(postal: string | null): string | null {
  const municipalities = postal === null ? [] : resolveMunicipalities(postal);
  const municipality = municipalities.length === 1 ? municipalities[0] : undefined;
  return municipality === undefined ? null : townLabel(municipality);
}

function fold(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Adult learner / "I wanna learn swimming" / adult lessons.
 * Narrow on purpose: a city rec-morning clock stays rec-morning's job.
 */
export function isAdultLearnAsk(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  if (/\badult\s+(?:swim(?:ming)?\s+)?lessons?\b/.test(text)) return true;
  if (/\badult\s+learn/.test(text)) return true;
  if (/\bi\s+(?:wanna|want to)\s+learn\b/.test(text) && /\bswim/.test(text)) return true;
  return false;
}

/**
 * Mid-signup / first-text: the locked kids-only door plus Hale's outstanding ask.
 * Cold start appends {@link recMorningReturnLine}'s COLD_START ask. Null when the
 * parent's text was not an adult-learn ask.
 */
export function adultLearnIntakeReply(input: {
  parentWords: string;
  pendingAsk: string;
  /** The session's coarse postal/FSA, or null before one is collected. */
  postal: string | null;
}): string | null {
  if (!isAdultLearnAsk(input.parentWords)) return null;
  const joined = `${adultLearnDoor(sessionCity(input.postal))} ${recMorningReturnLine(input.pendingAsk)}`;
  if (joined.length > INTAKE_MAX_REPLY_CHARS) {
    throw new Error(
      `adult-learn intake reply is ${joined.length} chars, cap is ${INTAKE_MAX_REPLY_CHARS}`,
    );
  }
  return joined;
}
