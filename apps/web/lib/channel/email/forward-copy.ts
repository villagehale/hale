/**
 * WHAT HALE SAYS ON THE FORWARDING DOOR — every outbound sentence, in one table.
 *
 * NO COMPOSER, and that is the injection defence rather than a sentence in a skill body.
 * A forwarded document is a third party's text; nothing it contains may become prose Hale
 * speaks. So each message here is a template over values the door itself computed — a
 * domain it parsed and a subject line out of the parent's own mailbox — and never a model
 * output.
 *
 * LANGUAGE comes from the answered parent's `users.locale`. Recorded honestly: NOTHING in
 * apps/web writes that column today (the only non-schema reference is a read, family.ts),
 * so every parent is `en-CA` and the French strings are unreachable in production. The
 * table ships anyway — the copy is correct where a parent reads it, and the switch is one
 * row away — but nobody should read the fr column as live.
 *
 * Plain text, because the reply transport sends `text` only: no markdown emphasis, since
 * a literal pair of asterisks in a plain-text mail is noise rather than weight.
 */

export type ForwardLocale = 'en' | 'fr';

/** The locale the copy is rendered in. Anything not French is English — the same
 * fail-to-English rule the rest of the product keeps. */
export function forwardLocale(usersLocale: string | null | undefined): ForwardLocale {
  return usersLocale?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/**
 * THE ASK. It carries the original subject line on purpose: on a filter auto-forward the
 * webhook's Message-ID is the school's, under the school's subject, so this may land as a
 * fresh "Your thread with Hale" conversation rather than beside the mail it is about. A
 * parent looking at a standalone ask still has to know which message it means. The subject
 * is the parent's own mailbox content, never a body, and it is never logged.
 */
export function forwardAsk(
  locale: ForwardLocale,
  args: { subject: string; domain: string },
): string {
  const subject = args.subject.trim();
  if (locale === 'fr') {
    return [
      subject
        ? `Vous m'avez transféré « ${subject} » de ${args.domain}.`
        : `Vous m'avez transféré un message de ${args.domain}.`,
      `Je ne l'ai pas lu — je ne lis que le courrier des expéditeurs que vous avez approuvés.`,
      `Répondez OUI et je lirai ce que ${args.domain} vous envoie.`,
      'Répondez NON et je ne vous le redemanderai plus.',
      `Sans réponse, j'oublierai ce message dans trois jours.`,
    ].join(' ');
  }
  return [
    subject
      ? `You forwarded "${subject}" from ${args.domain}.`
      : `You forwarded a message from ${args.domain}.`,
    `I haven't read it — I only read mail from senders you've said yes to.`,
    `Reply YES and I'll read what ${args.domain} sends you.`,
    `Reply NO and I won't ask about them again.`,
    `If you do nothing, I'll forget this message in three days.`,
  ].join(' ');
}

/** The acknowledgement of a NO. It states the deletion because the deletion happened —
 * the raw row is gone in the same transaction that wrote the block. */
export function forwardBlocked(locale: ForwardLocale, args: { domain: string }): string {
  return locale === 'fr'
    ? `Compris — je ne lirai pas le courrier de ${args.domain}, et j'ai supprimé le message que vous m'avez transféré. Je ne le redemanderai plus.`
    : `Understood — I won't read mail from ${args.domain}, and I've deleted the message you forwarded. I won't ask again.`;
}

/**
 * The ONE re-ask, and the door counts them: a sender that has already been asked twice is
 * met with silence rather than a third question (forward.ts). A parent who forwards a
 * fresh document to the answer address lands here, which is why the sentence names the
 * two words it can read — and an auto-responder that carries no machine marker at all
 * lands here too, which is why there is a bound.
 */
export function forwardUnclear(locale: ForwardLocale, args: { domain: string }): string {
  return locale === 'fr'
    ? `Désolé — était-ce oui ou non pour lire le courrier de ${args.domain}? Répondez OUI ou NON.`
    : `Sorry — was that a yes or a no about reading mail from ${args.domain}? Reply YES or NO.`;
}

/**
 * An answer to a question Hale can no longer find: a `.ref` whose sender row lapsed with
 * the three-day purge, or one from an ask that never reached the database. A verified
 * parent hears a sentence rather than nothing (rule #11), and it names no domain —
 * not knowing which one it was is the whole state.
 */
export function forwardUnknownRef(locale: ForwardLocale): string {
  return locale === 'fr'
    ? `Je ne retrouve plus le message dont il s'agit — il a peut-être expiré. Transférez-le-moi de nouveau et je vous poserai la question.`
    : `I've lost track of which message that was about — it may have expired. Forward it to me again and I'll ask.`;
}

/**
 * The acknowledgement of a YES, and it says what actually happened rather than what the
 * next rung will do. PR1 has no summariser, so the held document is deleted unread on the
 * decision — decision 10, nothing raw survives a settled sender — and the parent is told
 * so. When the summariser lands this sentence is replaced by the summary itself.
 */
export function forwardAllowed(locale: ForwardLocale, args: { domain: string }): string {
  return locale === 'fr'
    ? `Merci — je lirai désormais ce que ${args.domain} vous envoie. J'ai supprimé sans le lire le message que vous m'aviez transféré.`
    : `Thanks — from now on I'll read what ${args.domain} sends you. I've deleted the message you forwarded without reading it.`;
}
