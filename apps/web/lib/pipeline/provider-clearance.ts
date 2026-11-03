import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * VIL-556: content Hale received from a Google API (Gmail, Calendar, Drive), and
 * anything derived from it, is sent to Anthropic only. Never to the Vercel AI Gateway,
 * JEV, DeepSeek or any other provider, whatever the candidate-model flags say.
 *
 * The rule lives HERE and nowhere else. Every non-Anthropic transport (jev.ts and
 * budgetedAiGateway in client.ts) demands a {@link NonGoogleClearance}, and this module
 * is the only place one is minted: from an origin the caller declares, refusing every
 * Google origin. A non-Anthropic call on Google input therefore cannot be written
 * without declaring a false origin, and that lie is visible in review. A cast does not
 * work either: minted clearances are tracked at runtime, so a forged one throws at the
 * transport before any key is read or any request leaves.
 *
 * A refusal is a named outcome (rule #11): it is logged here, once, with the stage and
 * the refusal name only (never input text), and the caller returns it while the
 * Anthropic path runs instead. Privacy first: when the origin is unclear, refuse.
 *
 * The family_state witness depends on integrations rows OUTLIVING a disconnect.
 * Revoking keeps the row and nulls its tokens (integrations/store.ts, revokeConnection;
 * coparent/depart.ts does the same). A change that deletes the row on disconnect would
 * blind this witness: provider-clearance.pglite.test.ts pins "revoked still refuses".
 */

// No exported provider type exists in @hale/db; derived from the enum, never retyped.
type IntegrationProvider = (typeof schema.integrationProviderEnum.enumValues)[number];

export type ClearanceRefusal =
  /** The caller declared the input as Google content. */
  | 'google_derived_input'
  /** The caller cannot prove the input holds no Google content. */
  | 'origin_unproven'
  /** family_state: the family has or had a Google integrations row, in any status. */
  | 'family_has_google_connection'
  /** family_state: the witness read failed, so the answer is unknown (fail closed). */
  | 'origin_unreadable';

export type InputOrigin =
  /** The parent's own inbound words, not read from any Google API. */
  | { kind: 'parent_text' }
  | { kind: 'google' }
  | { kind: 'unproven' }
  /** Family-wide state (memory, conversations, bookings) with no per-row origin. */
  | { kind: 'family_state'; database: Database; familyId: string };

declare const clearanceBrand: unique symbol;

export interface NonGoogleClearance {
  readonly [clearanceBrand]: true;
  readonly basis: 'parent_text' | 'family_without_google';
}

export type ClearanceDecision = { cleared: NonGoogleClearance } | { refused: ClearanceRefusal };

/**
 * Exhaustive by type: a new integration_provider value fails to compile here until
 * someone classifies it. The scaffolded Google legs count, so a Classroom or Photos row
 * refuses before either ever syncs. Not CONNECTOR_PROVIDERS (integrations/google-oauth.ts),
 * which lists only the live connectors.
 */
export const GOOGLE_INTEGRATION_PROVIDER: Readonly<Record<IntegrationProvider, boolean>> = {
  gmail: true,
  gcal: true,
  gdrive: true,
  google_photos: true,
  google_classroom: true,
  outlook: false,
  apple_cal: false,
  icloud_photos: false,
  stripe: false,
  twilio: false,
  cra: false,
  esdc: false,
  pediatric_portal: false,
  brightwheel: false,
  himama: false,
};

const GOOGLE_PROVIDERS = (Object.keys(GOOGLE_INTEGRATION_PROVIDER) as IntegrationProvider[]).filter(
  (provider) => GOOGLE_INTEGRATION_PROVIDER[provider],
);

const minted = new WeakSet<object>();

export class ProviderClearanceError extends Error {
  constructor() {
    super('a non-Anthropic transport was called without a minted NonGoogleClearance');
    this.name = 'ProviderClearanceError';
  }
}

function mint(basis: NonGoogleClearance['basis']): ClearanceDecision {
  const clearance = Object.freeze({ basis }) as NonGoogleClearance;
  minted.add(clearance);
  return { cleared: clearance };
}

function refuse(stage: string, refusal: ClearanceRefusal): ClearanceDecision {
  console.warn({ stage, refusal }, `${stage}: non-Anthropic route refused; Anthropic runs`);
  return { refused: refusal };
}

async function familyHasGoogleRow(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        inArray(schema.integrations.provider, GOOGLE_PROVIDERS),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function clearForNonAnthropic(
  origin: InputOrigin,
  stage: string,
): Promise<ClearanceDecision> {
  switch (origin.kind) {
    case 'parent_text':
      return mint('parent_text');
    case 'google':
      return refuse(stage, 'google_derived_input');
    case 'unproven':
      return refuse(stage, 'origin_unproven');
    case 'family_state': {
      let hasGoogle: boolean;
      try {
        hasGoogle = await familyHasGoogleRow(origin.database, origin.familyId);
      } catch {
        return refuse(stage, 'origin_unreadable');
      }
      return hasGoogle
        ? refuse(stage, 'family_has_google_connection')
        : mint('family_without_google');
    }
  }
}

/** Throws {@link ProviderClearanceError} unless `clearance` was minted by
 * {@link clearForNonAnthropic}. Every non-Anthropic transport calls this first. */
export function assertClearance(clearance: NonGoogleClearance): void {
  if (typeof clearance !== 'object' || clearance === null || !minted.has(clearance)) {
    throw new ProviderClearanceError();
  }
}
