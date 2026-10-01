import {
  type DutyCopyLanguage,
  dutyOwnerEcho,
  dutyTitleMayBeSpoken,
  spokenFirstName,
} from './copy';

export { dutyTitleMayBeSpoken };
import { coparentDutyMemoryEnabled } from './flag';

/**
 * One group-sync line for a duty decision. Null when the memory flag is
 * off, copy may not leave, or the activity is not a kid event. A refused
 * activity is not included in the return value.
 */
export function dutySyncLine(
  language: DutyCopyLanguage,
  input: { name: string | null; activity: string; kid: string; day: string; time: string },
): string | null {
  if (!coparentDutyMemoryEnabled()) return null;
  if (!dutyTitleMayBeSpoken(input.activity)) return null;
  const name = spokenFirstName(input.name);
  if (!name) return null;
  return dutyOwnerEcho(language, {
    name,
    kid: input.kid,
    event: input.activity,
    day: input.day,
    time: input.time,
  });
}

export interface DutySyncDecision {
  decision: 'duty';
  activity: string;
  kid: string;
  day: string;
  time: string;
}

/**
 * A 1:1 duty decision the picked/passed reader does not cover.
 * "I'll take Maya's swim, Saturday at 3:00pm". A non-kid activity is null
 * and is not echoed back.
 */
export function readDutySyncDecision(body: string): DutySyncDecision | null {
  const trimmed = body
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
  if (!trimmed || trimmed.includes('?') || trimmed.includes('@')) return null;
  const match =
    /^(?:i'll|i will) take ([A-Za-z][A-Za-z'.-]{0,30})'s ([A-Za-z][A-Za-z0-9' -]{0,40}), ([A-Za-z]+day) at (\d{1,2}(?::\d{2})?(?:am|pm)?)$/i.exec(
      trimmed,
    );
  const kid = match?.[1]?.trim();
  const activity = match?.[2]?.trim();
  const day = match?.[3]?.trim();
  const time = match?.[4]?.trim();
  if (!kid || !activity || !day || !time) return null;
  if (!dutyTitleMayBeSpoken(activity)) return null;
  return { decision: 'duty', activity, kid, day, time };
}
