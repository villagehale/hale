import type { CaregiverRole } from '~/lib/channel/role-scope';

/**
 * VIL-241 · M6 — every word Hale texts about a caregiver, in one file.
 *
 * This is the SPEC, not a template layer (same contract as the intake copy): the
 * tests assert these strings, so a change to what a caregiver is PROMISED is a
 * reviewable diff rather than a quiet widening of what we later send them.
 *
 * The two scope lines below are the plain-words rendering of `role-scope.ts`. They
 * are stated TWICE on purpose — once to the parent before anyone is contacted, once
 * to the caregiver before they agree — because a double opt-in in which the two sides
 * were told different things is not informed consent, it is two guesses.
 */

/** How a role is named to a human. */
export const ROLE_LABEL: Record<CaregiverRole, string> = {
  grandparent: 'grandparent',
  nanny: 'nanny',
  babysitter: 'babysitter',
};

/**
 * What Hale asks the parent, and the invite a stranger receives, are written per
 * send (consent-ask). The scope those texts must carry — the week's schedule,
 * pickup reminders, the time and address, and the never-list — lives in that
 * skill. There is no fixed sentence and no token to recite. STOP stays the
 * carrier opt-out on the first text.
 */

/** Said to the parent once the invite is on its way. */
export function inviteSentAck(name: string): string {
  return `Sent - I've texted ${name}. They're in as soon as they say yes.`;
}

/** Said to the parent when they answer the confirmation with a no. */
export function inviteDroppedAck(name: string): string {
  return `Okay - I haven't texted ${name}.`;
}

export const CAREGIVER_WELCOME =
  "You're in - I'll text you the week's schedule and pickup reminders, and nothing else. Reply STOP anytime.";

export const CAREGIVER_DECLINE_ACK = "No problem - I won't text you again.";

/**
 * A nudge when the reply was neither yes nor no is written per send
 * (consent-ask, kind caregiver_nudge). There is no fixed sentence.
 */

/** The example shown when a parent clearly meant to add someone but we couldn't read
 * it. States the shape AND the three roles, so the next try succeeds. */
export const ADD_EXAMPLE =
  'Tell me who, their number, and what they are - like: add grandma 647-555-0199 as grandparent. I can do grandparent, nanny or babysitter.';

/**
 * A co-parent sees the whole family surface, so Hale will not text a number the other
 * parent typed and take a yes from whoever answers it. The refusal stands — what
 * changed is that it now has somewhere to send them.
 *
 * It used to close with "add them in the app" (skill audit P0 #4), then with "they need
 * to sign in as themselves". Both were true when written and neither is the shortest
 * true answer any more: the co-parent join link (lib/channel/join) makes the unblocking
 * move a text the parent sends and a link they forward. A refusal that names a
 * capability Hale actually has is the difference between a boundary and a dead end.
 */
export const CO_PARENT_REDIRECT =
  "A co-parent sees everything I show you, so I won't add one from a number you typed. Text me add my partner and I'll send you a link to forward to them.";

/** The number already has its own Hale account or an active caregiver slot. */
export const NUMBER_IN_USE =
  "That number is already set up with Hale, so I can't add it as a caregiver - they'd need to reply STOP there first.";

export const OWN_NUMBER = "That's your own number - you're already here.";

/** They have already been asked and have not answered. Asking again would be the
 * second unsolicited text they never agreed to. */
export const ALREADY_INVITED =
  "I've already texted them - I'll let you know as soon as they answer.";

/**
 * The number has told Hale no before, on either lane (VIL-355).
 *
 * NON-COMMITTAL on purpose, unlike the co-parent lane's own sentence: here the refusal
 * may have been made to any household, and "that number already said no to me" would
 * tell this parent something about a stranger's. It says only that Hale will not do it.
 */
export const CANNOT_TEXT_THAT_NUMBER =
  "I can't text that number for you. If they'd like to be here, they can text me first.";

/** The per-family invite meter. Says the bound plainly instead of failing silently. */
export const TOO_MANY_INVITES =
  "That's a lot of people in one day - I'll pick this up tomorrow. Nobody new has been texted.";

/** The whole of what a caregiver can ask Hale in v1: nothing. Said warmly, once per
 * message, so they know where the boundary is rather than being ignored. */
export function scopedReply(parentName: string | null): string {
  const who = parentName ?? 'the parents';
  return `That's one for ${who} - I only share the schedule here.`;
}
