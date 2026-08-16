import { permanentRedirect } from 'next/navigation';

/**
 * RETIRED (receipts-room slimdown). The milestones hub was old-positioning reference
 * content — a CDC-checkpoint library, which is what a parent already gets from a
 * search engine. Hale's pitch is not "read about milestones", it is "text a number and
 * the thing gets done", so the hub sent readers to the wrong promise. The checkpoint
 * data (lib/milestones) is untouched; only the public pages are gone.
 */
export default function MilestonesPage(): never {
  permanentRedirect('/');
}
