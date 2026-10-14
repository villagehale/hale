import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';

/**
 * VIL-353 · ledger names for the evening check-in, and the child phrase travel still
 * borrows. There is no fixed text in this file. The proactive writer speaks; a parent
 * never sees a sentence that was stored here.
 *
 * `checkin:ask` is the question the decider sent. `checkin:weekly` is the old
 * step-down notice, which asks nothing — the reply lane still excludes it so a
 * parent's next text is not filed against an announcement already on the ledger.
 * `checkin:ack` is an old receipt. New replies do not send one.
 */

export const CHECK_IN_ASK_TEMPLATE_KEY = 'checkin:ask';
export const CHECK_IN_STEP_DOWN_TEMPLATE_KEY = 'checkin:weekly';
export const CHECK_IN_ACK_TEMPLATE_KEY = 'checkin:ack';

/** What a travel brief calls the children when it cannot name them. */
export const GENERIC_CHILD_PHRASE = 'the kids';

/**
 * The children a travel brief may name: their first names, or {@link GENERIC_CHILD_PHRASE}.
 *
 * The caller has ALREADY dropped every 13+ child (rule #1). A household whose only
 * children are teenagers arrives here with an empty list and is answered generically.
 * A name that will not spell in GSM-7 costs the whole brief its budget, so the
 * household loses the name.
 */
export function childPhrase(names: readonly string[]): string {
  if (names.length === 0) return GENERIC_CHILD_PHRASE;
  const joined =
    names.length === 1
      ? (names[0] as string)
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;
  return isPrintableGsm7Basic(joined) ? joined : GENERIC_CHILD_PHRASE;
}
