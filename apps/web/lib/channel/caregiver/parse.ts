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

/** The number-shaped run inside a command. Shared with {@link ADD_COMMAND} so the two
 * readings of "is there a phone number here" can never disagree. */
const PHONE_RUN = '\\+?\\d[\\d\\s\\-().]*\\d';

/** `add <name> <number> as <role>` — anchored at both ends, so a sentence that merely
 * contains the words is not a command. */
const ADD_COMMAND = new RegExp(
  `^add\\s+(?<name>[\\p{L}\\p{M}'’.\\-]+(?:\\s+[\\p{L}\\p{M}'’.\\-]+)*)\\s+(?<phone>${PHONE_RUN})\\s+as\\s+(?<role>[\\p{L}\\- ]{2,20})$`,
  'iu',
);

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

/**
 * Whether the parent was TRYING to add someone. A failed parse on one of these owes an
 * example back; anything else is ordinary conversation and is left alone.
 *
 * VIL-260 · the prefix alone is NOT the signal. "add" is the verb parents use about
 * their own calendar far more often than about a caregiver ("add library story time
 * Saturday 10am"), and claiming every message that starts with it meant those never
 * reached the conversational layer at all — they were answered with an invite example.
 *
 * What only a caregiver command has is the SHAPE: a real NANP number AND the literal
 * " as " that separates the name from the role. Both, or it is conversation. A message
 * carrying both but not parsing (an unknown role word, a swapped order, a name with a
 * digit in it) is still an attempt and still gets the example — that is the whole reason
 * this predicate is separate from {@link parseAddCaregiver}.
 *
 * The number must NORMALIZE, not merely look numeric: "add the deadline 2026-08-01 as a
 * reminder" satisfies the anchored command regex in every other respect, and a shape
 * test that accepted any digit run would go on swallowing exactly the sentences this
 * exists to release.
 */
export function looksLikeAddCommand(body: string): boolean {
  const trimmed = body.trim();
  return (
    /^add\s/i.test(trimmed) && /\sas\s/i.test(trimmed) && containsPhoneNumber(trimmed)
  );
}

/** A run of digits the phone normalizer accepts as a CA/US line — never merely "some
 * digits", so a date or a time in a calendar request is not read as a number. */
function containsPhoneNumber(body: string): boolean {
  for (const match of body.matchAll(new RegExp(PHONE_RUN, 'g'))) {
    if (normalizePhoneE164(match[0])) return true;
  }
  return false;
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
