import {
  ALREADY_INVITED,
  CAREGIVER_ANSWER_PROMPT,
  CAREGIVER_DECLINE_ACK,
  OWN_NUMBER,
  TOO_MANY_INVITES,
} from '~/lib/channel/caregiver/copy';
import type { CoParentRefusal } from '~/lib/channel/caregiver/invites';
import { joinWelcome } from '~/lib/channel/join/copy';
import type { ReplyLanguage } from '~/lib/channel/language';
import { smsEncoding } from '~/lib/channel/sms-segments';

/**
 * VIL-355 · every word Hale texts about a CO-PARENT invite, in one file.
 *
 * This is the SPEC, not a template layer (the contract the intake, caregiver and join
 * copy all keep): the tests assert these strings, so a change to what a partner is
 * PROMISED before Hale texts them is a reviewable diff.
 *
 * WHY THE CAREGIVER STRINGS COULD NOT BE REUSED WHOLESALE. They name the wrong thing to
 * the wrong person: `NUMBER_IN_USE` says "I can't add it as a caregiver", and the scope
 * sentences enumerate a slice ("the week's schedule and nothing else") that is the exact
 * opposite of what a co-parent gets. A co-parent's scope is not a list, it is "what you
 * see", and saying it as a list would understate it.
 *
 * BILINGUAL, unlike the caregiver copy, and that is the point rather than an extra. This
 * is the one path in the product where Hale's FIRST EVER message to a person is
 * unprompted, and a Quebec stranger getting it in English only is the Law 25 / Charter
 * exposure the house's own ARRET/AIDE pattern (intake/copy.ts, CRTC §3.1) already exists
 * to answer. The language is read per message off the words in front of us
 * (language.ts) — the parent's own reply for their side, and the parent's authorising
 * reply for the invite, since the invitee has not written anything yet.
 *
 * GSM-7 ONLY, both languages, and inside two segments. `ç`, `â`, `ê`, `î`, `ô` and `û`
 * are NOT in the GSM-7 basic alphabet (only `é è à ù ì ò Ç` are), so one of them
 * anywhere in a French body collapses the budget from 306 units to 134 and splits a
 * stranger's first message into three. copy.test.ts holds the line.
 */

/** The longest inviter name this path will spend budget on — the same ceiling the
 * forwardable link keeps (join/copy.ts), because the two bodies are the same size. */
const MAX_INVITER_NAME_CHARS = 24;

/**
 * Whether the invite can afford to NAME the person who asked for it.
 *
 * DIVERGES DELIBERATELY from `affordableInviterName` (join/copy.ts), which drops an
 * unaffordable name and sends an anonymous body. A forwarded link is handed over by a
 * human who is standing right there; this is a cold text. "A parent added you as their
 * co-parent" from a number nobody recognises is the message this whole feature exists to
 * not send, so an unnameable inviter REFUSES the invite (`referrer_unnamed`) rather than
 * sending it anonymously.
 */
export function inviterNameIsAffordable(inviterName: string | null): inviterName is string {
  const trimmed = inviterName?.trim() ?? '';
  if (trimmed === '' || trimmed.length > MAX_INVITER_NAME_CHARS) return false;
  return smsEncoding(trimmed) === 'gsm7';
}

/**
 * What Hale asks the parent before the number is texted.
 *
 * It states the scope as the two powers a co-parent actually gets — the whole read
 * surface (`role-scope.ts`: `co_parent: PARENT_SCOPE`) and the ability to approve — and
 * not as a list of content classes. Both halves have to be there: a parent who reads
 * only "they see your week" has not been told that this person can say yes to Hale.
 */
export function coParentScopeConfirm(name: string, language: ReplyLanguage): string {
  return language === 'fr'
    ? `Ajouter ${name} comme co-parent veut dire qu'ils voient tout ce que je vous montre - toute votre semaine, chaque enfant - et qu'ils peuvent approuver des choses avec moi. Répondez OUI et je leur écris une fois. Ils doivent dire oui aussi.`
    : `Adding ${name} as your co-parent means they see everything I show you - your whole week, every child, all of it - and they can approve things with me. Reply YES and I'll text them once. They have to say yes too.`;
}

/**
 * THE ONE MESSAGE. Who asked (by name — see {@link inviterNameIsAffordable}), what Hale
 * is, what saying yes gets them, and how to stop. The opt-out rides on the first message
 * a stranger ever gets from us, in the language it is written in.
 */
export function coParentInviteBody(inviterName: string, language: ReplyLanguage): string {
  return language === 'fr'
    ? `Bonjour - ${inviterName} vous a ajouté comme co-parent sur Hale. Je suis l'assistant qui garde le fil de la semaine de leur famille. Dites oui et vous verrez toute leur semaine et pourrez m'écrire n'importe quand. Répondez OUI pour accepter. Répondez ARRET à tout moment.`
    : `Hi - ${inviterName} added you as their co-parent on Hale. I'm the assistant that keeps their family's week straight. Say yes and you'll see their whole week and can text me anything, anytime. Reply YES to accept. Reply STOP anytime.`;
}

/** Said to the parent once the invite is on its way. */
export function coParentInviteSentAck(name: string, language: ReplyLanguage): string {
  return language === 'fr'
    ? `C'est parti - j'ai écrit à ${name}. Ils sont dans la famille dès qu'ils disent oui.`
    : `Sent - I've texted ${name}. They're in as soon as they say yes.`;
}

/** Said to the parent when they answer the scope question with a no. */
export function coParentInviteDroppedAck(name: string, language: ReplyLanguage): string {
  return language === 'fr'
    ? `D'accord - je n'ai pas écrit à ${name}.`
    : `Okay - I haven't texted ${name}.`;
}

/** The partner's first message AFTER they accept. The English half is the join link's own
 * welcome verbatim — the same person arrives through both doors and must not be told two
 * different things about what they just joined. */
export function coParentWelcome(inviterName: string | null, language: ReplyLanguage): string {
  if (language !== 'fr') return joinWelcome(inviterName);
  const who = inviterNameIsAffordable(inviterName) ? inviterName : 'votre co-parent';
  return `Vous y voilà - ${who} vous a ajouté comme co-parent, donc vous voyez ce qu'ils voient ici et vous pouvez m'écrire n'importe quand. Répondez ARRET à tout moment.`;
}

/** The invitee said no. The inviting parent is told NOTHING — the caregiver precedent:
 * a refusal from a number is that person's business, not the household's. */
export const CO_PARENT_DECLINE_ACK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: CAREGIVER_DECLINE_ACK,
  fr: 'Pas de souci - je ne vous écrirai plus.',
};

/** The one nudge an invitee gets when their reply was neither yes nor a keyword. */
export const CO_PARENT_ANSWER_PROMPT_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: CAREGIVER_ANSWER_PROMPT,
  fr: 'Répondez OUI pour accepter, ou ARRET si vous ne voulez pas.',
};

/**
 * The parent has no name on file, so Hale cannot say who sent the text.
 *
 * It offers the door that does not need a name: a link the parent forwards themselves,
 * because a message handed over by a human needs no introduction.
 */
export const REFERRER_UNNAMED_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: "I'd be texting them out of the blue, so I want to say who sent me - tell me your name first, or text add my partner for a link you forward.",
  fr: "Je leur écrirais sans prévenir, alors je veux pouvoir dire qui m'envoie - dites-moi votre nom d'abord, ou écrivez add my partner pour un lien à transférer.",
};

/** The number already has a Hale account. Deliberately does not say WHOSE — it may not
 * be this parent's to know (rule #1), and the caregiver twin says "as a caregiver". */
export const CO_PARENT_NUMBER_IN_USE_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: "That number is already set up with Hale, so I can't add it as your co-parent - they'd need to reply STOP there first.",
  fr: "Ce numéro est déjà configuré avec Hale, donc je ne peux pas l'ajouter comme co-parent - il faudrait d'abord répondre ARRET là-bas.",
};

/** One co-parent seat per household. Says the bound plainly rather than opening a second
 * one quietly. */
export const CO_PARENT_SEAT_TAKEN_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'You already have a co-parent here. I keep one, so nobody is added without the other knowing.',
  fr: "Vous avez déjà un co-parent ici. J'en garde un seul, pour que personne ne soit ajouté sans que l'autre le sache.",
};

/**
 * This number has already refused an invite from us, so we will not ask it again.
 *
 * Says the refusal happened without saying who refused or when — the parent asked us to
 * text a number and is owed the reason their request went nowhere, and the person behind
 * the number is owed their no meaning no.
 */
export const PREVIOUSLY_DECLINED_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: "That number already said no to me once, so I won't text it again. If that's changed, they can text me first.",
  fr: "Ce numéro m'a déjà dit non une fois, donc je ne lui écrirai plus. Si les choses ont changé, il peut m'écrire en premier.",
};

export const CO_PARENT_OWN_NUMBER_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: OWN_NUMBER,
  fr: "C'est votre propre numéro - vous avez déjà votre place ici.",
};

export const CO_PARENT_ALREADY_INVITED_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: ALREADY_INVITED,
  fr: "Je leur ai déjà écrit - je vous dis dès qu'ils répondent.",
};

export const CO_PARENT_TOO_MANY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: TOO_MANY_INVITES,
  fr: "Ça fait beaucoup de monde en une journée - je reprends demain. Personne de nouveau n'a été contacté.",
};

/**
 * Every refusal, by the reason the state machine returned, so the route answers a NAMED
 * outcome rather than choosing a sentence of its own.
 *
 * Exhaustive over {@link CoParentRefusal} BY TYPE: a new way to refuse is a compile error
 * until somebody writes what the parent is told, in both languages. A refusal with no
 * sentence is a parent who asked Hale to text their partner and got silence.
 */
export const CO_PARENT_REFUSAL_COPY: Record<CoParentRefusal, Record<ReplyLanguage, string>> = {
  own_number: CO_PARENT_OWN_NUMBER_BY_LANGUAGE,
  number_in_use: CO_PARENT_NUMBER_IN_USE_BY_LANGUAGE,
  already_invited: CO_PARENT_ALREADY_INVITED_BY_LANGUAGE,
  too_many: CO_PARENT_TOO_MANY_BY_LANGUAGE,
  co_parent_seat_taken: CO_PARENT_SEAT_TAKEN_BY_LANGUAGE,
  previously_declined: PREVIOUSLY_DECLINED_BY_LANGUAGE,
  referrer_unnamed: REFERRER_UNNAMED_BY_LANGUAGE,
};
