import {
  type HealthRegion,
  emergencyFacts,
  healthFactsForRegion,
  medicalMustInclude,
  medicalTextHasRequiredNumbers,
} from '~/lib/channel/health-resources';
import type { ReplyLanguage } from '~/lib/channel/language';
import type { SaidLineFact, SaidLineWriter } from './said-line';

export type MedicalReplyKind = 'health' | 'emergency';

/**
 * Same log the crisis page uses (`logCrisisUnanswered`): `{ urgent: true }`
 * and a message ending `page #ops now`. That is the shape the log drain pages on.
 */
const PAGE = 'URGENT: medical reply flagged, no reply sent - page #ops now';

/**
 * A medical reply was owed and nothing goes out. There is no fixed line to
 * fall back on. Never silent: an urgent, body-free log for #ops.
 */
export function logMedicalUnanswered(kind: MedicalReplyKind, where: string): void {
  console.error({ urgent: true, kind, where }, PAGE);
}

/**
 * The medical reply in the model's words. A health worry gets the region health
 * line (both, when the region is unknown) and 911. An emergency gets 911 only.
 * A reply that misses 911, or that still names 811 or 988 on an emergency, is
 * written once more from those same facts. If it still fails, nothing is sent
 * and #ops is paged.
 */
export async function deliverMedicalReply(input: {
  kind: MedicalReplyKind;
  parentWords: string;
  where: string;
  region: HealthRegion | null;
  language: ReplyLanguage | null;
  writer: SaidLineWriter | null | undefined;
}): Promise<string | null> {
  if (!input.writer) {
    logMedicalUnanswered(input.kind, input.where);
    return null;
  }
  let written: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    written = await writeMedicalLine(input.writer, input);
    if (written && medicalTextHasRequiredNumbers(input.kind, written)) return written;
  }
  logMedicalUnanswered(input.kind, input.where);
  return null;
}

async function writeMedicalLine(
  writer: SaidLineWriter,
  input: {
    kind: MedicalReplyKind;
    parentWords: string;
    region: HealthRegion | null;
    language: ReplyLanguage | null;
  },
): Promise<string | null> {
  const facts: Record<string, SaidLineFact> =
    input.kind === 'emergency' ? emergencyFacts() : { ...healthFactsForRegion(input.region) };
  return writer.write({
    purpose: 'health',
    language: input.language,
    parentWords: input.parentWords,
    facts,
    mustInclude: medicalMustInclude(input.kind),
  });
}
