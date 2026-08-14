import { permanentRedirect } from 'next/navigation';

/** RETIRED (receipts-room slimdown) — village-era browsing, not a receipt. Saved rows
 * are untouched; `/api/mobile/village/saved` still serves them to the native app. */
export default function SavedPage(): never {
  permanentRedirect('/home');
}
