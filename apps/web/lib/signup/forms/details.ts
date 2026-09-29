import type { SignupSession } from '../types';

const SENSITIVE = /\ballerg|\bmedical\b|\bmedication\b|\bphysician\b|waiver|anaphylax|\bepipen\b/i;
const EMAILISH = /@/;
const PHONEISH = /\+\d{8,}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;

/**
 * Party size and a seating note travel on the authorized session.
 * They are filled only when that session already carries them.
 * A note that looks like health, contact, or a waiver is refused.
 */
export function normalizeSession(session: SignupSession): SignupSession | null {
  const partySize = session.partySize ?? null;
  if (partySize !== null && (!Number.isInteger(partySize) || partySize < 1 || partySize > 20)) {
    return null;
  }
  const raw = session.seatingNote ?? null;
  if (raw === null || raw.trim().length === 0) {
    return { ...session, partySize, seatingNote: null };
  }
  const seatingNote = raw.trim();
  if (seatingNote.length > 80 || /[\r\n]/.test(seatingNote)) return null;
  if (SENSITIVE.test(seatingNote) || EMAILISH.test(seatingNote) || PHONEISH.test(seatingNote)) {
    return null;
  }
  return { ...session, partySize, seatingNote };
}
