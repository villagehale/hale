import { FREEMAIL_HOSTS } from '~/lib/integrations/going';

/**
 * VIL-685 · DOMAINS THAT SEND FOR MANY PEOPLE, so authenticated mail from one of them
 * names nobody: not a school list, a list of mail platforms. Mail authenticated as one of
 * these proves only that the platform sent it — a coach on a mailbox, a daycare on a
 * child-care app, a teacher through Google Classroom, a newsletter through a mailer — and
 * its host is never looked up, its text never read for a break.
 *
 * Mailboxes come from `FREEMAIL_HOSTS` (integrations/going.ts), the one list of them.
 * Below are the registrable domains of the platforms that send on behalf of schools,
 * daycares, clubs and businesses. Shared hosting with a Public Suffix List entry
 * (`github.io`, `wixsite.com`) needs no line here: sender.ts already keeps each site on it
 * its own. A platform missing here still has to pass the sender check (school-sender.ts).
 */
export const SHARED_SENDER_HOSTS: ReadonlySet<string> = new Set([
  // Suites whose apps send as themselves (Classroom, Groups, Forms, Teams, Outlook).
  'google.com',
  'googlegroups.com',
  'microsoft.com',
  'office365.com',
  'onmicrosoft.com',
  'facebookmail.com',
  // Bulk and transactional mailers.
  'amazonses.com',
  'ccsend.com',
  'constantcontact.com',
  'createsend.com',
  'hubspotemail.net',
  'list-manage.com',
  'mailchimpapp.net',
  'mailgun.org',
  'mailjet.com',
  'mandrillapp.com',
  'mcdlv.net',
  'mcsv.net',
  'sendgrid.net',
  'sendinblue.com',
  'smore.com',
  'sparkpostmail.com',
  // School, daycare and club messaging platforms.
  'bloomz.net',
  'classdojo.com',
  'edsby.com',
  'himama.com',
  'instructure.com',
  'konstella.com',
  'mybrightwheel.com',
  'parentsquare.com',
  'procaresoftware.com',
  'remind.com',
  'schoolmessenger.ca',
  'schoolmessenger.com',
  'schoology.com',
  'seesaw.me',
  'signupgenius.com',
  'sportsengine.com',
  'storypark.com',
  'teamsnap.com',
]);

/** The registrable domain sends for many people: it names no school. */
export function isSharedSender(host: string): boolean {
  return FREEMAIL_HOSTS.has(host) || SHARED_SENDER_HOSTS.has(host);
}
