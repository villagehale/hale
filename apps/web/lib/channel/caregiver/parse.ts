import { normalizePhoneE164 } from '~/lib/channels/phone';
import type { CaregiverRole, FamilyRole } from '~/lib/channel/role-scope';

/**
 * VIL-241 · M6 — reading "add grandma 647-555-0199 as grandparent" off a text.
 *
 * DELIBERATELY NOT A MODEL. This sentence hands a stranger's phone number to Hale and
 * starts a disclosure of a family's week to a third party. A probabilistic reading of
 * WHICH number and WHICH role would mean a bad parse texts the wrong person a child's
 * schedule — so the command is matched by a strict pattern, and anything the pattern
 * does not fit is answered with an example rather than guessed at. (A model may help
 * with phrasing later; it will still have to produce this exact shape to be acted on.)
 *
 * The pattern's one load-bearing detail: a NAME may not contain digits. That is what
 * makes the name/number boundary unambiguous without asking the parent to punctuate —
 * "Nana +1 647 555 0199" splits in exactly one place.
 */

/** `add <name> <number> as <role>` — anchored at both ends, so a sentence that merely
 * contains the words is not a command. */
const ADD_COMMAND =
  /^add\s+(?<name>[\p{L}\p{M}'’.\-]+(?:\s+[\p{L}\p{M}'’.\-]+)*)\s+(?<phone>\+?\d[\d\s\-().]*\d)\s+as\s+(?<role>[\p{L}\- ]{2,20})$/iu;

/** A name we will echo back to the parent and store as the invite's label. Bounded
 * because it is third-party PII arriving over an unauthenticated channel. */
const MAX_NAME_LENGTH = 40;

/**
 * The role words a parent actually uses, mapped to the roles the scope matrix knows.
 * Deliberately small: an unrecognised word is answered with the example, never mapped
 * to "probably the closest one" — the closest one grants access to a family's week.
 */
const CAREGIVER_WORDS: Record<string, CaregiverRole> = {
  grandparent: 'grandparent',
  grandma: 'grandparent',
  grandpa: 'grandparent',
  grandmother: 'grandparent',
  grandfather: 'grandparent',
  nanny: 'nanny',
  babysitter: 'babysitter',
  sitter: 'babysitter',
};

/**
 * Roles this command deliberately does NOT grant. A co-parent gets the whole family
 * surface, and a single YES texted from a phone is not enough to authorise that — the
 * existing invite path (family_invites) verifies who they are. Recognised here only so
 * the parent gets a straight answer instead of "I didn't understand".
 */
const UNSUPPORTED_WORDS: Record<string, FamilyRole> = {
  'co-parent': 'co_parent',
  'co parent': 'co_parent',
  coparent: 'co_parent',
  partner: 'co_parent',
  parent: 'co_parent',
};

export type ParsedAddCaregiver =
  | { ok: true; name: string; phoneE164: string; role: CaregiverRole }
  | { ok: false; reason: 'unparseable' | 'unsupported_role' };

/** Whether the parent was TRYING to add someone. A failed parse on one of these owes
 * an example back; anything else is ordinary conversation and is left alone. */
export function looksLikeAddCommand(body: string): boolean {
  return /^add\s/i.test(body.trim());
}

export function parseAddCaregiver(body: string): ParsedAddCaregiver {
  const match = ADD_COMMAND.exec(body.trim());
  const groups = match?.groups;
  if (!groups) return { ok: false, reason: 'unparseable' };

  const roleWord = (groups.role as string).toLowerCase().replace(/\s+/g, ' ').trim();
  if (roleWord in UNSUPPORTED_WORDS) return { ok: false, reason: 'unsupported_role' };
  const role = CAREGIVER_WORDS[roleWord];
  if (!role) return { ok: false, reason: 'unparseable' };

  const name = (groups.name as string).replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: 'unparseable' };
  }

  const phoneE164 = normalizePhoneE164(groups.phone as string);
  if (!phoneE164) return { ok: false, reason: 'unparseable' };

  return { ok: true, name, phoneE164, role };
}
