import type { ConsentAsk, ConsentAskWriter } from '~/lib/channel/consent-ask';
import type { ConsentReader, ConsentReadingResult } from '~/lib/channel/consent-reply';

/**
 * A stand-in for the consent writer. Tests assert this text. Production writes
 * with the model, and this double never calls one.
 */
export function askWriter(
  text: string | ((ask: ConsentAsk) => string | null) = writtenAsk,
): ConsentAskWriter {
  return {
    write: async (ask) => (typeof text === 'function' ? text(ask) : text),
  };
}

/** The text the double writes, so a test can expect the same sentence. */
export function writtenAsk(ask: ConsentAsk): string {
  switch (ask.kind) {
    case 'founder_ping':
      return `A family just joined from the ${ask.location} poster. Want me to send your note?`;
    case 'founder_retry':
      return 'That note did not go. Want me to try again?';
    case 'partial_failure':
      return ask.draftCount === 1
        ? '1 change is waiting. Want me to keep it, or drop it?'
        : `${ask.draftCount} changes are waiting. Want me to keep them, or drop them?`;
    case 'checkup_drafted':
      return 'Drafted onto your week. The clinic call is still yours. Want me to keep it?';
    case 'caregiver_scope':
      return `Adding ${ask.name} as ${ask.role}. They would get the week's schedule, pickup reminders, and the time and address. Never health or appointments, never anything about a teenager, never sign-ups or money, never account settings, and nothing else.`;
    case 'caregiver_invite':
      return `${ask.who} added you as ${ask.role}. Reply STOP anytime. I keep their family's week straight. You get the week's schedule, pickup reminders, and the time and address. Never health or appointments.`;
    case 'caregiver_nudge':
      return 'Want to take that on? Reply STOP anytime.';
    case 'coparent_scope':
      return `Texting ${ask.name} as a co-parent. They would see everything I show you, and they can approve things.`;
    case 'coparent_invite':
      return ask.language === 'fr'
        ? `${ask.inviterName} vous ajoute. Repondez ARRET.`
        : `${ask.inviterName} added you as a co-parent. Reply STOP anytime.`;
    case 'coparent_nudge':
      return ask.language === 'fr'
        ? 'Vous voulez participer? Repondez ARRET.'
        : 'Want to join? Reply STOP anytime.';
    case 'forward_revoke':
      return ask.language === 'fr'
        ? 'Couper le transfert? Le courrier serait ignore. Vous pouvez ignorer ceci.'
        : 'Turn off your forwarding address? Mail sent there would be ignored. You can ignore this.';
    default:
      return 'Want me to go ahead?';
  }
}

/**
 * A stand-in for the consent reader. "yes" and "no" are the fixture words the
 * tests already send. Anything else is neither, which is what a failed read is.
 */
export function yesNoReader(): ConsentReader {
  return {
    read: async ({ text }) => yesNo(text),
  };
}

export function yesNo(text: string): ConsentReadingResult {
  const folded = text.trim().toLowerCase();
  if (folded === 'yes' || folded === 'oui' || folded === 'yeah') {
    return { verdict: 'yes', target: 'none' };
  }
  if (
    folded === 'no' ||
    folded === 'non' ||
    folded === 'nope' ||
    folded === 'no thanks' ||
    folded === 'stop intros'
  ) {
    return { verdict: 'no', target: 'none' };
  }
  return { verdict: 'neither', target: 'none' };
}
