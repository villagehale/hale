import {
  ALREADY_INVITED,
  CANNOT_TEXT_THAT_NUMBER,
  CAREGIVER_DECLINE_ACK,
  OWN_NUMBER,
  TOO_MANY_INVITES,
} from '~/lib/channel/caregiver/copy';
import { inviterNameIsAffordable } from '~/lib/channel/coparent/copy';
import { joinWelcome } from '~/lib/channel/join/copy';
import { asksAboutEyeCare } from '~/lib/channel/off-domain/copy';
import {
  type SpokenLineRequest,
  type SpokenLineWriter,
  acceptSpokenLine,
} from '~/lib/channel/spoken-line';

/**
 * The scripted model every web test gets. The sentences live here, as the
 * fixture's answers, and nowhere in the product send path.
 */

const PRIMARY_CARE =
  /\b(?:family doctor|family physician|\bgp\b|general practitioner|pediatrician|paediatrician|nurse practitioner|family practice|medecin de famille|médecin de famille|pediatre|pédiatre|infirmiere praticienne|infirmière praticienne)\b/i;

const PROVIDER_EN =
  "Finding you a doctor isn't something I can do - but Health Care Connect is Ontario's list for a family doctor or pediatrician, and you register by calling 811. That same number answers health questions any time.";
const PROVIDER_FR =
  "Trouver un médecin pour vous, je ne peux pas - mais Accès Soins est la liste de l'Ontario pour un médecin de famille ou un pédiatre, et on s'y inscrit en composant le 811. Ce numéro répond aussi aux questions de santé à toute heure.";
const EYE =
  "You can book an optometrist directly - no referral needed. OHIP covers a full eye exam every 12 months for anyone 19 and under, so it's free with your child's health card. The Ontario Association of Optometrists lists them at FindAnEyeDoctor.ca.";
const UNPLACEABLE_EN =
  "I don't have a verified way to get you that one, and I'd rather say so than send you somewhere that can't help. Once you've got an appointment, tell me and I'll put it on your week.";
const UNPLACEABLE_FR =
  "Je n'ai pas de piste vérifiée pour celui-là, et je préfère le dire que vous envoyer au mauvais endroit. Dès que vous avez un rendez-vous, dites-le moi et je l'ajoute à votre semaine.";

function fr(language: string | null | undefined): boolean {
  const tag = (language ?? '').trim().toLowerCase();
  return tag === 'fr' || tag.startsWith('fr-');
}

function pick(language: string | null | undefined, en: string, french: string): string {
  return fr(language) ? french : en;
}

function fill(pattern: string, slots: Record<string, string | undefined>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? '');
}

function scriptedLine(request: SpokenLineRequest): string | null {
  const { purpose, language } = request;
  const facts = request.facts ?? {};
  const text = render(purpose, language ?? null, facts);
  return text === undefined ? null : acceptSpokenLine(text, request.verbatim);
}

function render(
  purpose: string,
  language: string | null,
  facts: Readonly<Record<string, string>>,
): string | undefined {
  switch (purpose) {
    case 'group_welcome':
      return pick(
        language,
        "Hi, I'm Hale. This thread is your kids' year — both of you, and me. What should I call you?",
        "Salut, c'est Hale. Ce fil, c'est l'annee des enfants: vous deux, et moi. Comment je t'appelle?",
      );
    case 'group_calendar_receipt':
      return fill(
        pick(
          language,
          "{name}'s calendar is connected. I'll keep the kids' stuff straight across both.",
          'Le calendrier de {name} est connecte. Je suis les activites des enfants sur les deux.',
        ),
        facts,
      );
    case 'group_gmail_receipt':
      return fill(
        pick(
          language,
          "{name}'s Gmail is connected. I'll pull out the kids' dates; the inbox stays private.",
          'Le Gmail de {name} est connecte. Je garde les dates des enfants; la boite reste privee.',
        ),
        facts,
      );
    case 'group_picked':
      return fr(language)
        ? `Pour info: ${facts.name} a choisi ${facts.activity} pour ${facts.kid}, ${facts.day} a ${facts.time}.`
        : `Quick sync: ${facts.name} picked ${facts.activity} for ${facts.kid}, ${facts.day} at ${facts.time}.`;
    case 'group_passed':
      return fr(language)
        ? `Pour info: ${facts.name} a laisse tomber ${facts.activity} pour ${facts.kid}.`
        : `Quick sync: ${facts.name} passed on ${facts.activity} for ${facts.kid}.`;
    case 'group_kid_event':
      return fill(
        pick(
          language,
          "Heads up: {name} added {kid}'s {event}, {day} at {time}.",
          'Pour info: {name} a ajoute {event} pour {kid}, {day} a {time}.',
        ),
        facts,
      );
    case 'group_conflict':
      return fill(
        pick(
          language,
          "{kid}'s {event} is {day} at {time}, and you're both busy then. Who's taking it?",
          "{event} pour {kid}, {day} a {time}, et vous etes pris tous les deux. Qui s'en occupe?",
        ),
        facts,
      );
    case 'group_handoff':
      return fill(
        pick(
          language,
          "Tomorrow: {name} has {kid}'s {event} at {time}.",
          "Demain: {name} s'occupe de {event} pour {kid} a {time}.",
        ),
        facts,
      );
    case 'group_both_free':
      return fill(
        pick(
          language,
          "You're both free {slot1} or {slot2}. Want the sign-up page for one?",
          "Vous etes libres tous les deux {slot1} ou {slot2}. Vous voulez la page d'inscription pour l'un des deux?",
        ),
        facts,
      );
    case 'group_travel_opening':
      return `Trip: ${facts.city}, ${facts.days}. A couple of things on for ${facts.kids}:`;
    case 'group_departure': {
      const who = facts.name?.trim()
        ? facts.name
        : pick(language, 'Your co-parent', 'Votre co-parent');
      return fr(language)
        ? `${who} a quitte Hale. Rien n'a change dans l'annee des enfants, et je suis toujours la.`
        : `${who} left Hale. Nothing in the kids' year changed, and I'm still here.`;
    }
    case 'how_it_went':
      return fr(language)
        ? `Comment ca s'est passe pour ${facts.activity} ? Une ligne suffit.`
        : `How did ${facts.activity} go? One line is plenty.`;
    case 'coparent_invite_sent':
      return fr(language)
        ? `C'est parti - j'ai écrit à ${facts.name}. Ils sont dans la famille dès qu'ils disent oui.`
        : `Sent - I've texted ${facts.name}. They're in as soon as they say yes.`;
    case 'coparent_invite_dropped':
      return fr(language)
        ? `D'accord - je n'ai pas écrit à ${facts.name}.`
        : `Okay - I haven't texted ${facts.name}.`;
    case 'coparent_welcome': {
      if (!fr(language)) return joinWelcome(facts.inviterName?.trim() ? facts.inviterName : null);
      const who = inviterNameIsAffordable(facts.inviterName ?? null)
        ? facts.inviterName
        : 'votre co-parent';
      return `Vous y voilà - ${who} vous a ajouté comme co-parent, donc vous voyez ce qu'ils voient ici et vous pouvez m'écrire n'importe quand. Répondez ARRET à tout moment.`;
    }
    case 'coparent_decline_ack':
      return pick(language, CAREGIVER_DECLINE_ACK, 'Pas de souci - je ne vous écrirai plus.');
    case 'coparent_referrer_unnamed':
      return pick(
        language,
        "I'd be texting them out of the blue, so I want to say who sent me - tell me your name first, or text add my partner for a link you forward.",
        "Je leur écrirais sans prévenir, alors je veux pouvoir dire qui m'envoie - dites-moi votre nom d'abord, ou écrivez add my partner pour un lien à transférer.",
      );
    case 'coparent_unavailable':
      return pick(
        language,
        CANNOT_TEXT_THAT_NUMBER,
        "Je ne peux pas écrire à ce numéro pour vous. S'ils veulent se joindre à vous ici, ils peuvent m'écrire en premier.",
      );
    case 'coparent_seat_taken_late':
      return pick(
        language,
        "Thanks for answering - somebody else was added as the co-parent in the meantime, so there's no spot for you here. I won't text you again.",
        "Merci d'avoir répondu - quelqu'un d'autre a été ajouté comme co-parent entre-temps, donc il n'y a plus de place ici. Je ne vous écrirai plus.",
      );
    case 'coparent_departed_notice':
      return pick(
        language,
        'Your co-parent has left Hale. Your week is yours alone now - nothing in it changed, and the join link still works if you want to add someone.',
        "Votre co-parent a quitte Hale. Votre semaine est a vous seul maintenant - rien n'y a change, et le lien d'invitation fonctionne toujours.",
      );
    case 'coparent_invite_expired':
      return pick(
        language,
        "Thanks for answering - that invitation has expired, so there's nothing for me to add you to. Ask them to send it again and I'll be right here.",
        "Merci d'avoir répondu - cette invitation a expiré, donc je ne peux pas vous ajouter. Demandez-leur de la renvoyer et je serai là.",
      );
    case 'coparent_number_in_use':
      return pick(
        language,
        "That number is already set up with Hale, so I can't add it as your co-parent - they'd need to reply STOP there first.",
        "Ce numéro est déjà configuré avec Hale, donc je ne peux pas l'ajouter comme co-parent - il faudrait d'abord répondre ARRET là-bas.",
      );
    case 'coparent_seat_taken':
      return pick(
        language,
        'You already have a co-parent here. I keep one, so nobody is added without the other knowing.',
        "Vous avez déjà un co-parent ici. J'en garde un seul, pour que personne ne soit ajouté sans que l'autre le sache.",
      );
    case 'coparent_previously_declined':
      return pick(
        language,
        "That number already said no to me once, so I won't text it again. If that's changed, they can text me first.",
        "Ce numéro m'a déjà dit non une fois, donc je ne lui écrirai plus. Si les choses ont changé, il peut m'écrire en premier.",
      );
    case 'coparent_own_number':
      return pick(
        language,
        OWN_NUMBER,
        "C'est votre propre numéro - vous avez déjà votre place ici.",
      );
    case 'coparent_already_invited':
      return pick(
        language,
        ALREADY_INVITED,
        "Je leur ai déjà écrit - je vous dis dès qu'ils répondent.",
      );
    case 'coparent_too_many':
      return pick(
        language,
        TOO_MANY_INVITES,
        "Ça fait beaucoup de monde en une journée - je reprends demain. Personne de nouveau n'a été contacté.",
      );
    case 'linq_group_make':
      return fr(language)
        ? `Ouvre un groupe iMessage avec eux et ce numero: ${facts.line}. Dans ce groupe, envoie: ${facts.phrase}.`
        : `Start an iMessage group with them and this number: ${facts.line}. In that group, send: ${facts.phrase}.`;
    case 'linq_coparent_ask':
      return fr(language)
        ? `Tu veux l'autre parent sur l'annee des enfants aussi? Ouvre un groupe iMessage avec eux et ce numero: ${facts.line}. Dans ce groupe, envoie: ${facts.phrase}.`
        : `Want the other parent on the kids' year too? Start an iMessage group with them and this number: ${facts.line}. In that group, send: ${facts.phrase}.`;
    case 'linq_group_trigger_1to1':
      return fr(language)
        ? `Cette phrase va dans le groupe. Ouvrez un groupe iMessage avec eux et ${facts.line}, puis envoyez: ${facts.phrase}.`
        : `That phrase belongs in the group. Start an iMessage group with them and ${facts.line}, then send: ${facts.phrase}.`;
    case 'linq_group_claim_refused':
      return pick(
        language,
        "I can't use this thread as your kids' year.",
        "Je ne peux pas utiliser ce fil comme l'annee de vos enfants.",
      );
    case 'linq_group_line_missing':
      return pick(
        language,
        "I don't have a number for you to add to a group yet.",
        "Je n'ai pas encore de numero a ajouter a un groupe.",
      );
    case 'group_member_welcome':
      return facts.adder
        ? fill(
            pick(
              language,
              "Hi, I'm Hale. {adder} added you so the family can sort the week in one place. What should I call you?",
              "Bonjour, c'est Hale. {adder} vous a ajoute pour qu'on s'organise ensemble. Comment je vous appelle?",
            ),
            facts,
          )
        : pick(
            language,
            "Hi, I'm Hale. I help the family sort the week in one place. What should I call you?",
            "Bonjour, c'est Hale. J'aide la famille a organiser la semaine au meme endroit. Comment je vous appelle?",
          );
    case 'group_stranger_hold':
      return fill(
        pick(
          language,
          'Someone new joined this chat and I don\'t know them yet, so I\'m pausing here. {parentA}, say "add them" if they share the load.',
          'Une nouvelle personne s\'est jointe a la conversation et je ne la connais pas encore, alors je fais une pause. {parentA}, dis "ajoute cette personne" si elle partage la charge.',
        ),
        facts,
      );
    case 'year_find_prompt':
      return pick(
        language,
        'Which of these should I look at first?',
        'Lequel je regarde en premier?',
      );
    case 'year_find_none':
      return pick(language, 'None of these', 'Aucun de ceux-la');
    case 'year_find_sandbox_title':
      return facts.slot === '1'
        ? pick(language, 'Swim at the rec centre', 'Nage au centre recreatif')
        : pick(language, 'Library storytime', 'Heure du conte a la bibliotheque');
    case 'who_takes_prompt':
      return fill(
        pick(
          language,
          "Who's taking {kid}'s {event}, {day} at {time}?",
          "Qui s'occupe de {event} pour {kid}, {day} a {time}?",
        ),
        facts,
      );
    case 'figure_it_out':
      return pick(language, "We'll figure it out", 'On verra');
    case 'both_free_prompt':
      return pick(
        language,
        'Which time works for both of you?',
        'Quel creneau vous arrange tous les deux?',
      );
    case 'both_free_none':
      return pick(language, 'None of these', 'Aucun de ceux-la');
    case 'forward_address':
      return fr(language)
        ? `Transférez votre courrier à ${facts.address} et je le lirai. D'un expéditeur que vous n'avez pas approuvé, je vous demande d'abord - rien n'est lu avant votre oui. Quand vous voulez, textez désactiver mon adresse de transfert.`
        : `Forward mail to ${facts.address} and I'll read it. From a sender you haven't okayed, I ask you first - nothing is read until you say yes. Any time, text turn off my forwarding address.`;
    case 'forward_revoke':
      if (facts.outcome === 'not_configured') {
        return pick(
          language,
          `You don't have a forwarding address set up, so there is nothing to turn off. Text forwarding address if you want one.`,
          `Vous n'avez pas d'adresse de transfert, il n'y a donc rien à désactiver. Textez adresse de transfert si vous en voulez une.`,
        );
      }
      return pick(
        language,
        'Done - your forwarding address is off. Mail sent to it from now on is ignored. Text forwarding address if you ever want a new one.',
        'Fait - votre adresse de transfert est désactivée. Le courrier qui y arrive est ignoré. Textez adresse de transfert si vous en voulez une autre.',
      );
    case 'forward_revoke_declined':
      return pick(
        language,
        'Okay - your forwarding address is still on.',
        'Entendu - votre adresse de transfert reste active.',
      );
    case 'connector_noun':
      if (facts.provider === 'gcal') return pick(language, 'Google Calendar', 'Google Agenda');
      if (facts.provider === 'gmail') return 'Gmail';
      return 'Google Drive';
    case 'connector_revoke': {
      const noun = facts.noun ?? '';
      if (facts.outcome === 'revoke_failed') {
        return fr(language)
          ? `Quelque chose s'est mal passé chez moi avec votre ${noun} - rien n'a changé. Réessayez dans une minute.`
          : `Something went wrong on my end with your ${noun} - nothing was changed. Try me again in a minute.`;
      }
      if (facts.outcome === 'not_connected') {
        return fr(language)
          ? `Hale n'a pas de clés pour votre ${noun} - rien à déconnecter. Demandez dans ce fil si vous voulez le lier.`
          : `Hale has no keys for your ${noun} - nothing to disconnect. Ask in this thread if you want to link it.`;
      }
      return fr(language)
        ? `Fait - votre ${noun} est déconnecté, Hale a supprimé ses clés. Google garde Hale jusqu'à ce que vous l'enleviez sur myaccount.google.com/permissions`
        : `Done - your ${noun} is disconnected and Hale deleted its keys. Google still lists Hale until you remove it at myaccount.google.com/permissions`;
    }
    case 'provider_access': {
      const body = facts.body ?? '';
      if (asksAboutEyeCare(body)) return EYE;
      if (PRIMARY_CARE.test(body)) return pick(language, PROVIDER_EN, PROVIDER_FR);
      return pick(language, UNPLACEABLE_EN, UNPLACEABLE_FR);
    }
    case 'action_line': {
      const when = facts.when ? `, ${facts.when}` : '';
      const url = facts.url ?? '';
      const move = facts.move ?? '';
      const table = fr(language)
        ? {
            register_open: `La page est ici : ${url}`,
            register_later_preview: `Les programmes sont deja en ligne si vous voulez voir : ${url}`,
            register_later: `Voici la page : ${url}`,
            sign_up: `Il faut s'inscrire pour celle-la : ${url}`,
            just_go: `Pas d'inscription${when} : ${url}`,
          }
        : {
            register_open: `The page is here: ${url}`,
            register_later_preview: `The listings are up already if you want a look: ${url}`,
            register_later: `Here's the page: ${url}`,
            sign_up: `Sign-up needed for this one: ${url}`,
            just_go: `No sign-up needed${when}: ${url}`,
          };
      return table[move as keyof typeof table] ?? table.register_open;
    }
    case 'memory_group_sync':
      return fr(language)
        ? facts.change === 'correct'
          ? `${facts.who} a corrige quelque chose.`
          : `${facts.who} m'a demande d'oublier quelque chose.`
        : facts.change === 'correct'
          ? `${facts.who} corrected something.`
          : `${facts.who} asked me to forget something.`;
    case 'group_plan_options':
      return fill(
        pick(
          language,
          'I found a few that could work for {topic}: {options}',
          "J'ai trouve quelques idees pour {topic} : {options}",
        ),
        facts,
      );
    case 'group_plan_followup':
      return fill(
        pick(
          language,
          '{unanswered}, still thinking about {topic}?',
          '{unanswered}, vous reflechissez encore a {topic} ?',
        ),
        facts,
      );
    case 'group_plan_progress':
      return facts.winning
        ? fill(
            pick(
              language,
              '{yes} are in for {winning}. {maybe} are a maybe.',
              '{yes} sont partants pour {winning}. {maybe} hesistent.',
            ),
            facts,
          )
        : fill(
            pick(
              language,
              'So far {yes} yes, {no} no, {maybe} maybe.',
              'Pour l instant {yes} oui, {no} non, {maybe} peut-etre.',
            ),
            facts,
          );
    default:
      return undefined;
  }
}

export const scriptedSpokenLineWriter: SpokenLineWriter = {
  async write(request) {
    return scriptedLine(request);
  },
};
