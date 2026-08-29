import { permanentRedirect } from 'next/navigation';

/**
 * The family editor moved up a level: /family IS the editor now (Instinct-adapted
 * refresh). The middleware answers this path with a real 308 under the receipts IA;
 * this permanentRedirect is the defense-in-depth the retired-routes pattern
 * documents — the surface cannot render even if the middleware gate is bypassed.
 */
export default function FamilyMembersPage() {
  permanentRedirect('/family');
}
