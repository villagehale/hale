import type { Database } from '@hale/db';
import { isEnabled } from '@hale/flags';
import type { OptOutReadInput } from '~/lib/channel/intake/opt-out-reader';
import { isReminderOnlyGuest } from './store';

/**
 * VIL-742. A party guest ends the reminder in plain words, and the RSVP page says so
 * without a keyword. Exactly `true`. Off: the page and every read are today's.
 */
export function rsvpGuestPlainStopEnabled(): boolean {
  return isEnabled('rsvp-guest-plain-stop');
}

/**
 * The guest fact for one opt-out read. Empty for everyone else and with the flag off, so
 * every other request keeps its bytes and no recording is re-keyed.
 */
export async function guestReadFact(
  database: Database,
  phoneHash: string,
  now: Date,
): Promise<Pick<OptOutReadInput, 'partyGuest'>> {
  if (!rsvpGuestPlainStopEnabled()) return {};
  return (await isReminderOnlyGuest(database, phoneHash, now)) ? { partyGuest: true } : {};
}
