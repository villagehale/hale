import { permanentRedirect } from 'next/navigation';

/**
 * RETIRED (receipts-room slimdown). The newborn-era logging surface — a daily
 * destination from the pre-pivot platform, not a receipt. The logs themselves are
 * untouched: `/api/mobile/companion/*` still reads and writes them for the native
 * Diary, and nothing here deleted a row.
 */
export default function CompanionPage(): never {
  permanentRedirect('/home');
}
