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
 * VIL-355 · the words that mean "the other parent of these children".
 *
 * Each one names a SPECIFIC relationship, which is the whole reason they may seat a
 * co-parent when `parent` below may not. The seat is the entire family surface, so the
 * word that opens it has to be one nobody writes by accident about a grandmother.
 */
const CO_PARENT_WORDS: Record<string, 'co_parent'> = {
  partner: 'co_parent',
  spouse: 'co_parent',
  wife: 'co_parent',
  husband: 'co_parent',
  'co-parent': 'co_parent',
  'co parent': 'co_parent',
  coparent: 'co_parent',
};

/**
 * Roles this command deliberately does NOT grant. `parent` is the survivor of VIL-241's
 * longer list: it is what a parent writes about a grandparent, a step-parent and their
 * own partner alike, and the scope behind it is the whole household — so the ambiguous
 * word keeps the redirect while the specific ones above get the flow. Recognised here
 * only so the parent gets a straight answer instead of "I didn't understand".
 */
const UNSUPPORTED_WORDS: Record<string, FamilyRole> = {
  parent: 'co_parent',
};

/**
 * The determiner a parent writes in front of the relationship, dropped.
 *
 * "as my partner" is how the sentence is actually written — it is the wording the whole
 * feature was specified around — and "my partner" matched nothing in either table, so the
 * command fell to the example. Stripping the determiner rather than adding "my partner",
 * "our nanny" and the rest to the maps keeps ONE entry per relationship: a second spelling
 * of a role word is how one of them ends up with a fix the other does not get.
 *
 * It cannot widen what is grantable. The word behind the determiner is still looked up in
 * the same two closed tables, so "as my parent" is the same refusal "as parent" is.
 */
const ROLE_DETERMINERS = /^(?:my|our|their|the)\s+/;

function normalizeRoleWord(role: string): string {
  return role.toLowerCase().replace(/\s+/g, ' ').trim().replace(ROLE_DETERMINERS, '');
}

/** Every role this one command can open an invite for. */
export type AddRole = CaregiverRole | 'co_parent';

interface ParsedAdd {
  ok: true;
  name: string;
  phoneE164: string;
}

/**
 * Two `ok: true` arms rather than one with a widened `role`, because the ROLE is what
 * decides which lane runs: a caregiver add goes through the scoped double opt-in, a
 * co-parent add through VIL-355's. Discriminating here means a caller that has checked
 * the role is holding a value the other lane's functions will not accept, so the two can
 * never be crossed by accident.
 */
export type ParsedCaregiverAdd = ParsedAdd & { role: CaregiverRole };
export type ParsedCoParentAdd = ParsedAdd & { role: 'co_parent' };

export type ParsedAddCaregiver =
  | ParsedCaregiverAdd
  | ParsedCoParentAdd
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

  const roleWord = normalizeRoleWord(groups.role as string);
  // `Object.hasOwn` and not `in`, and own-key reads and not bracket access on a plain
  // object: the role regex admits `constructor`, and `normalizeRoleWord` lowercases, so
  // "add Sam 647-555-0199 as constructor" reached `CO_PARENT_WORDS['constructor']` and
  // got back `Object.prototype.constructor` — a truthy value typed `AddRole`. It failed
  // closed only because the `in` check above happened to fire first, which made the
  // ORDER of two guards the thing standing between a prototype key and a co-parent seat.
  if (Object.hasOwn(UNSUPPORTED_WORDS, roleWord)) return { ok: false, reason: 'unsupported_role' };
  const role: AddRole | undefined = Object.hasOwn(CAREGIVER_WORDS, roleWord)
    ? CAREGIVER_WORDS[roleWord]
    : Object.hasOwn(CO_PARENT_WORDS, roleWord)
      ? CO_PARENT_WORDS[roleWord]
      : undefined;
  if (!role) return { ok: false, reason: 'unparseable' };

  const name = (groups.name as string).replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: 'unparseable' };
  }

  const phoneE164 = normalizePhoneE164(groups.phone as string);
  if (!phoneE164) return { ok: false, reason: 'unparseable' };

  return role === 'co_parent'
    ? { ok: true, name, phoneE164, role }
    : { ok: true, name, phoneE164, role };
}
