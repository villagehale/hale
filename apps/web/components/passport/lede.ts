import type { KidCard } from '~/lib/passport/read';

export function passportLede(kid: KidCard): string {
  if (kid.pronoun === 'her') {
    return 'Her passport: everything she’s tried, stamped as it happens. You have the final say.';
  }
  if (kid.pronoun === 'his') {
    return 'His passport: everything he’s tried, stamped as it happens. You have the final say.';
  }
  return `${kid.name}’s passport: everything stamped as it happens. You have the final say.`;
}
