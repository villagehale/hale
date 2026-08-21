/**
 * THE FOUNDER'S OWN VOICE — the three fixed lines of the welcome-note lane.
 *
 * FIXED, NOT COMPOSED, and that is the whole product decision. Everything else Hale
 * texts a family is Hale's writing; this one message is a person's. A model asked to
 * write "a warm note from the founder" would produce a warm note from the product
 * wearing his name, which is the one thing this feature must not be. So the words are
 * his, they are here, and the only thing that varies is which poster the family came in
 * from.
 *
 * GSM-7, like every other authored body on this channel (sms-copy-encoding.test.ts
 * enforces it against this file). The founder's draft ended with an em dash; an em dash
 * re-encodes the whole message as UCS-2 and cuts the segment budget from 160 characters
 * to 70, so it is written as the hyphen a phone renders identically.
 */

/** The ledger's `template_key` for the ping into the founder's own thread. */
export const FOUNDER_PING_TEMPLATE_KEY = 'founder_welcome:ping';

/** The ledger's `template_key` for the note that lands in the new family's thread. The
 * receipts surface and a PIPEDA read both name the message by this. */
export const FOUNDER_NOTE_TEMPLATE_KEY = 'founder_welcome:note';

/**
 * What the founder is told. NOTHING ABOUT THE FAMILY (rule #1): not a parent's name, not
 * a child's, not an age, not a number. The poster is the only fact in it, and it is a
 * fact about a piece of paper on a wall.
 */
export function founderPing(location: string): string {
  return `A new family just joined from the ${location} poster. Reply YES and I'll send them your welcome note.`;
}

/** What the family gets, in his words. */
export function founderNote(location: string): string {
  return `A note from Barton, the dad who built Hale: thank you for being one of our first ${location} families. If anything ever feels off, just say so right here - I read what matters. - B`;
}

/** What the founder gets back once the note has gone. */
export const FOUNDER_NOTE_SENT_ACK = 'Sent - your note is in their thread.';

/** What the founder gets back when he says no. The offer is closed, and the line says so
 * rather than leaving him wondering whether it is still hanging. */
export const FOUNDER_NOTE_DECLINED_ACK = 'No problem - I have closed that one out.';

/**
 * The family cannot be texted at all — they pressed STOP, or the household is gone. The
 * offer is CLOSED, because there is nothing left for a second yes to reach, and the line
 * says both halves out loud. Rule #11: a send that did not happen is never silence.
 */
export const FOUNDER_NOTE_UNREACHABLE_ACK =
  'I could not reach that family, so the note did not go. Closing that one out.';

/** The wire ate it. The offer stays OPEN — unlike the line above, there is something left
 * to try — so the line says what to do next rather than closing the loop. */
export const FOUNDER_NOTE_FAILED_ACK =
  'The note did not get out just now. Still open - reply YES to try again.';
