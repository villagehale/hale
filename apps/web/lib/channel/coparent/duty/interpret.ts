import type { DutyParse, DutyParseInput } from './parse';
import { parseDutyReply } from './parse';

/**
 * Rules first. The extractor runs only when the rules do not recognise the
 * reply. A missing extractor is named `not_configured` (rule #11), not a guess.
 */

export type DutyExtractor = (input: DutyParseInput) => Promise<DutyParse | null>;

export async function interpretDutyReply(
  input: DutyParseInput,
  extract?: DutyExtractor,
): Promise<DutyParse> {
  const rules = parseDutyReply(input);
  if (rules.method !== 'none') return rules;
  if (!extract) return rules;
  const extracted = await extract(input);
  if (!extracted) return rules;
  return extracted;
}
