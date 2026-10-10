import { permanentRedirect } from 'next/navigation';

/** RETIRED (receipts-room slimdown) — village-era browsing, not a receipt. Saved rows
 * are untouched. */
export default function SavedPage(): never {
  permanentRedirect('/home');
}
