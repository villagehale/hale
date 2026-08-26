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

/** The allow-list, in plain words: schedule + pickup_duty + event_logistics. */
const GETS_THEY = "the week's schedule, pickup reminders, and the time and address for anything they're helping with";
const GETS_YOU = "the week's schedule, pickup reminders, and the time and address for anything you're helping with";

/** The never-list, in plain words. Named item by item — "a limited view" tells a
 * person nothing, and the point of saying it is that they can hold us to it. */
const NEVER =
  'Never health or appointments, never anything about a teenager, never sign-ups or money, never account settings - the schedule and nothing else.';

/** What Hale asks the parent before ANY number is texted. */
export function scopeConfirm(name: string, role: CaregiverRole): string {
  return `Adding ${name} as ${ROLE_LABEL[role]} means they'd get ${GETS_THEY}. ${NEVER} Reply YES and I'll text them - they have to say yes too.`;
}

/**
 * The invite itself: who asked, exactly what they'd receive, and how to stop. The
 * STOP line is CASL's, and it rides on the FIRST message a stranger ever gets from us.
 */
export function inviteBody(inviterName: string | null, role: CaregiverRole): string {
  const who = inviterName ? `${inviterName} added you` : 'A parent added you';
  // The inviter is named FIRST so "their family" has someone to point at. The other
  // order put the pronoun a whole sentence ahead of its referent, and in the anonymous
  // branch ahead of nothing at all — on the first message a stranger ever gets.
  return `Hi - ${who} as ${ROLE_LABEL[role]}. I'm Hale, the assistant that keeps their family's week straight. If you say yes I'll text you ${GETS_YOU}. ${NEVER} Reply YES to accept. Reply STOP anytime.`;
}

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

/** The one nudge a caregiver gets when their reply was neither yes nor STOP. */
export const CAREGIVER_ANSWER_PROMPT = "Reply YES to accept, or STOP if you'd rather not.";

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

/** The per-family invite meter. Says the bound plainly instead of failing silently. */
export const TOO_MANY_INVITES =
  "That's a lot of people in one day - I'll pick this up tomorrow. Nobody new has been texted.";

/** The whole of what a caregiver can ask Hale in v1: nothing. Said warmly, once per
 * message, so they know where the boundary is rather than being ignored. */
export function scopedReply(parentName: string | null): string {
  const who = parentName ?? 'the parents';
  return `That's one for ${who} - I only share the schedule here.`;
}
