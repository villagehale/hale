/**
 * VIL-245 · M10 — what a stranger sees on a birthday invite, and the one thing they
 * must never see.
 *
 * THE DISCLOSURE STANCE. Everything on this card is content the HOST typed and then
 * asked Hale to publish: the party's name, its time, and its address. An invitation
 * whose location was redacted would not be an invitation, so the location is passed
 * through as entered — that is host-AUTHORIZED disclosure, and it is the only kind on
 * this surface. Hale adds nothing of its own: no child row, no sibling, no family name,
 * no coarse area, no other event.
 *
 * THE ONE EXCEPTION IS A TEENAGER (rule #1). A 13+ child's name is redacted even though
 * the host typed it and even though nothing on the row is flagged sensitive, because a
 * public web page is a third-party disclosure and the teen never agreed to it. The gate
 * is the child's AGE via deriveStage — deterministic, never a classifier flag — and it
 * is applied HERE, at read time, on every render. That placement is deliberate: a
 * title redacted once at write time would go stale the day a 12-year-old turns 13, and
 * a stored title is exactly the kind of value the MCP read-tools lesson says never to
 * trust. Nothing that reaches a guest is trusted from storage.
 *
 * Pure: no DB, no `new Date()` of its own. The caller supplies the teen names it
 * resolved by age, so the gate is deterministic in tests.
 */

/** What a redacted teen becomes. Reads naturally in the possessive ("the guest of
 * honour's 16th birthday") and carries no age or gender Hale would be inventing. */
export const GUEST_OF_HONOUR = 'the guest of honour';

/** Escapes a first name so it is matched as literal text. A name is user data, and a
 * name like "A." compiled as a pattern would redact every two-character run. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes every teenager's first name from host-entered text.
 *
 * Whole-word, case-insensitive. Whole-word matters in both directions: a host who typed
 * "maya" must not slip through, and a party at "Samosa Palace" must not lose its venue
 * to a child named Sam. Non-word boundaries are used rather than `\b` so a name ending
 * in punctuation ("A.") still anchors correctly.
 */
export function redactTeenNames(text: string, teenFirstNames: readonly string[]): string {
  let out = text;
  for (const name of teenFirstNames) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    out = out.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])${literal(trimmed)}(?![\\p{L}\\p{N}])`, 'giu'),
      (_match, prefix: string) => `${prefix}${GUEST_OF_HONOUR}`,
    );
  }
  return out;
}

/**
 * `Saturday, August 23 at 2:00 PM`, in the FAMILY's zone.
 *
 * Spelled-out month and a 12-hour clock, which is not the repo's usual compact house
 * style (`formatDayHeading` gives "Sat, Aug 23") — an invitation is read once by people
 * who have never seen this product, and an abbreviation they have to decode is a
 * missed party. The family zone, not the viewer's: a guest opening the link while
 * travelling must still be told when the party is where the party is.
 */
export function partyWhen(startsAt: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(startsAt);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(startsAt);
  return `${day} at ${time}`;
}

/** The complete public payload. Every field is a string a guest may read; there is no
 * id, no token, no child reference and no family identifier anywhere in it. */
export interface PartyCard {
  title: string;
  when: string;
  location: string | null;
  cancelled: boolean;
}

export interface PartyCardInput {
  /** As the host typed it. */
  title: string;
  /** As the host typed it, or null when they gave none. */
  location: string | null;
  startsAt: Date;
  timeZone: string;
  cancelled: boolean;
  /** First names of the household's 13+ children — the age gate, resolved by the caller. */
  teenFirstNames: readonly string[];
}

export function buildPartyCard(input: PartyCardInput): PartyCard {
  return {
    title: redactTeenNames(input.title, input.teenFirstNames),
    when: partyWhen(input.startsAt, input.timeZone),
    location:
      input.location === null ? null : redactTeenNames(input.location, input.teenFirstNames),
    cancelled: input.cancelled,
  };
}
