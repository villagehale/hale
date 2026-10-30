import { type ChildError, type ChildInput as BaseChildInput, validateChild } from '~/lib/onboarding/children';

/**
 * Pure (I/O-free) input shaping for the Family page's child + area forms, kept
 * out of the 'use server' module so it can export sync helpers and be unit-tested
 * without a request. Validation reuses onboarding's validateChild — one source of
 * truth for the age window and DOB rules.
 */

/** A child as typed into the Family page form: onboarding's fields + optional interests. */
export interface ChildInput extends BaseChildInput {
  /** Comma-separated free-text interests, e.g. "swimming, music". Optional. */
  interests?: string;
}

export { type ChildError, validateChild };

/**
 * Splits the comma-separated interests field into trimmed, de-duplicated,
 * non-empty tags — the shape children.interests (jsonb string[]) stores. Empty or
 * whitespace-only input yields [] (no interests), never a fabricated tag.
 */
export function parseInterests(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (tag.length > 0) {
      seen.add(tag);
    }
  }
  return [...seen];
}
