import { permanentRedirect } from 'next/navigation';

/**
 * RETIRED (receipts-room slimdown). The web chat competed with the product: Hale is
 * a number you text, and a second, worse chat window inside the app taught parents to
 * come here instead. `/api/coach/*` is untouched — the channel coach runs through
 * it; only this browser surface is gone.
 */
export default function CoachPage(): never {
  permanentRedirect('/home');
}
