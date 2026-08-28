/**
 * QR source tags that grant the arriving family a LIFETIME Family tier at provisioning.
 *
 * Data-driven so a comped venue is one registry entry, not a magic string buried in the
 * transaction. Every code here must also be a SOURCE_VENUES key (copy.ts) — the greeting
 * names the venue back — and the grant itself is applied once, in provisionFromIntake,
 * where it writes its own immutable audit row (rule #6). Billing is inert and nothing
 * downgrades a tier, so a family granted 'family' this way keeps it for life.
 */
export const LIFETIME_FAMILY_SOURCE_CODES = new Set<string>([
  'earlyon-georgetown',
  'earlyon-acton',
  // First GTA boards to agree to post (2026-08-27) — founder-granted. The
  // earlyon-markham spelling is the legacy code on the copy already hanging at the
  // Markham venue (copy.ts); it keeps the comp until the reprint replaces it.
  'markham',
  'earlyon-markham',
  'ossington',
]);
