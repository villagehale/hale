/**
 * The template keys that mean "Hale asked this family for a fact about the parent".
 *
 * They live in their own module, importing nothing, because they are read from BOTH
 * directions: the senders stamp them onto the outbound `channel_messages` row, and the
 * two capturers query for them to decide whether an inbound reply is answering a question
 * Hale actually asked. A key defined next to one sender and copied next to the other is
 * how a capture silently stops working — the ask still goes out, the reply still arrives,
 * and nothing claims it.
 *
 * THE STAMPED ROW IS THE WHOLE PENDING-ASK RECORD. There is no separate state table: an
 * ask is pending because a message carrying its key was delivered, and the capture window
 * is open for as long as the fact is still missing. That is deliberate — the fact's own
 * absence is the state, so there is nothing to keep in sync with it.
 */

/** Intake's ask, appended to the consent acknowledgment. Name only. */
export const PARENT_NAME_ASK_TEMPLATE_KEY = 'parent_name_ask';

/** The intros sweep's gap-fill. Name, email, or both — one ask either way, because a
 * parent holding two questions from Hale about themselves cannot tell them apart. */
export const INTRO_IDENTITY_ASK_TEMPLATE_KEY = 'village_intro:identity_ask';

/** Every ask a NAME may be answering. */
export const IDENTITY_ASK_TEMPLATE_KEYS = [
  PARENT_NAME_ASK_TEMPLATE_KEY,
  INTRO_IDENTITY_ASK_TEMPLATE_KEY,
] as const;
