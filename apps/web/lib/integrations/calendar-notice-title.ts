import { mayHideContact, withoutContacts } from '../format/contact-shape';

/**
 * The calendar's title, made safe to hand the writer: one line, bounded, and with no link,
 * phone or email left in it (VIL-633). The title may be a stranger's words: anyone can
 * send the parent an invite. The cut comes first, because a cut can turn a word that is
 * not a link ("evil.co9") into one that is ("evil.co..."). A title that may hide a contact
 * the strip cannot see ("555/0199/1234", "name(at)evil(dot)app") is dropped whole.
 *
 * Relative imports only, so the calendar-kid-notice eval runs this file as-is.
 */
const NOTICE_TITLE_MAX = 80;

export function kidNoticeTitle(raw: string | null | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  const cut = text.length <= NOTICE_TITLE_MAX ? text : `${text.slice(0, NOTICE_TITLE_MAX - 3)}...`;
  return mayHideContact(cut) ? '' : withoutContacts(cut);
}
