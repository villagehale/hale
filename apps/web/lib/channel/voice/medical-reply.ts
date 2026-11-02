import {
  type HealthRegion,
  healthFactsForRegion,
  medicalMustInclude,
  medicalTextHasRequiredNumbers,
} from '~/lib/channel/health-resources';
import type { SaidLineFact, SaidLineWriter } from './said-line';

export type MedicalReplyKind = 'health' | 'emergency';

const PAGE = 'URGENT: medical reply flagged, no reply sent - page #ops now';

/**
 * A medical reply was owed and nothing goes out. There is no fixed line to
 * fall back on. Never silent: an urgent, body-free log for #ops.
 */
export function logMedicalUnanswered(kind: MedicalReplyKind, where: string): void {
  console.error({ urgent: true, kind, where }, PAGE);
}

/**
 * The medical reply in the model's words. 811 and 911 are facts. Ontario or
 * British Columbia gets that health line; an unknown region gets both. The
 * check is presence (`medicalTextHasRequiredNumbers`): 911 always on an
 * emergency, dashes and spaces ignored. A miss is one more write. If that
 * also fails, nothing is sent and #ops is paged.
 */
export async function deliverMedicalReply(input: {
  kind: MedicalReplyKind;
  parentWords: string;
  where: string;
  region: HealthRegion | null;
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
  },
): Promise<string | null> {
  const facts: Record<string, SaidLineFact> = { ...healthFactsForRegion(input.region) };
  return writer.write({
    purpose: 'health',
    language: null,
    parentWords: input.parentWords,
    facts,
    mustInclude: medicalMustInclude(input.kind),
  });
}
