import { permanentRedirect } from 'next/navigation';

/** RETIRED (receipts-room slimdown) — the companion's log browser, retired with its
 * parent surface. */
export default function CompanionLogsPage(): never {
  permanentRedirect('/home');
}
