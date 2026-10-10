import { permanentRedirect } from 'next/navigation';

/**
 * RETIRED (receipts-room slimdown). The newborn-era logging surface — a daily
 * destination from the pre-pivot platform, not a receipt. The logs themselves are
 * untouched, and nothing here deleted a row.
 */
export default function CompanionPage(): never {
  permanentRedirect('/home');
}
