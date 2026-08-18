/**
 * QR source tags that grant the arriving family a LIFETIME Family tier at provisioning.
 *
 * Data-driven so a comped venue is one registry entry, not a magic string buried in the
 * transaction. Every code here must also be a SOURCE_VENUES key (copy.ts) — the greeting
 * names the venue back — and the grant itself is applied once, in provisionFromIntake,
 * where it writes its own immutable audit row (rule #6). Billing is inert and nothing
 * downgrades a tier, so a family granted 'family' this way keeps it for life.
 */
export const LIFETIME_FAMILY_SOURCE_CODES = new Set<string>(['earlyon-georgetown']);
