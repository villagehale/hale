import { contactsOutside, mayHideContact } from '../format/contact-shape';

/**
 * The calendar's title, made safe to hand the writer: one line, bounded, and dropped whole
 * when it holds a link, a phone or an email, or may hide one the readers cannot see
 * ("555/0199/1234", "name(at)evil(dot)app") (VIL-633). The title can be someone else's
 * words, and what is left of a title once a contact is cut out of it ("details at") is
 * still theirs. Both the title as sent and the cut are read, because a cut can turn a word
 * that is not a link ("evil.co9") into one that is ("evil.co...") and can split a phone
 * into runs too short to read as one.
 *
 * Relative imports only, so the calendar-kid-notice eval runs this file as-is.
 */
const NOTICE_TITLE_MAX = 80;

export function kidNoticeTitle(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  const cut = text.length <= NOTICE_TITLE_MAX ? text : `${text.slice(0, NOTICE_TITLE_MAX - 3)}...`;
  const mayReach = (one: string) => mayHideContact(one) || contactsOutside(one, []).length > 0;
  return mayReach(text) || mayReach(cut) ? '' : cut;
}

/**
 * The title the writer may be handed, from where the parent stands on the event: only an
 * event they organized, or their own, keeps its (cleaned) title. Anyone else's event,
 * accepted or not, is handed none, because its organizer can rename it at any time after
 * the parent said yes. The notice then names the kid, the day and the times instead.
 * The first of `raws` that is left with words wins.
 */
export function noticeTitleFor(
  standing: string | null,
  ...raws: ReadonlyArray<string | null | undefined>
): string {
  if (standing !== 'organizer' && standing !== 'own') return '';
  for (const raw of raws) {
    const title = kidNoticeTitle(raw);
    if (title !== '') return title;
  }
  return '';
}
