import {
  createRegistrationReader,
  registrationDate,
  registrationWhen,
  registrationHasOpened,
  windowReadTarget,
  type RegistrationReader,
} from '~/lib/registration/read';
import { REGISTRATION_WINDOWS } from '~/lib/registration/registration-windows-data';
import { INTAKE_MAX_REPLY_CHARS, recMorningBody, recMorningReturnLine } from './copy';
import { YMCA_PORTAL } from './facts';
import { matchRecMorning, postalMentioned, type RecMorningWhere } from './match';
import { preferDistrictRows, resolveDistrict } from '~/lib/registration/match-registration-windows';

/** Seeds identify pages/cycles only. Dates are read on this question, never rendered
 * from the static rec-morning copy (including its old YMCA date). */
export async function liveRecMorningReply(
  body: string,
  now: Date,
  where?: RecMorningWhere | null,
  reader: RegistrationReader = createRegistrationReader(),
): Promise<string | null> {
  const topic = matchRecMorning(body, where);
  if (!topic) return null;
  if (
    [
      'toronto_waitlist',
      'toronto_wishlist',
      'toronto_efun',
      'ymca_follow',
      'two_parents',
      'jack_of_sports',
    ].includes(topic)
  )
    return recMorningBody(topic, now, where);
  if (topic === 'ymca_gta_swim') {
    const reading = await reader(
      {
        municipality: 'YMCA GTA',
        programDomain: 'swim',
        cycleLabel: 'the swim registration cycle on this page',
        sourceUrl: YMCA_PORTAL,
        timeZone: 'America/Toronto',
      },
      now,
    );
    const date = registrationDate(reading, false);
    return date
      ? `The YMCA page says ${registrationWhen(reading, date)}. ${YMCA_PORTAL}`
      : `I couldn't verify a current YMCA registration date. ${YMCA_PORTAL}`;
  }
  const city = topic.replace(/_(?:rec|swim)$/, '');
  const domain = topic.endsWith('_swim') ? 'swim' : topic.endsWith('_rec') ? 'rec_program' : null;
  let targets = REGISTRATION_WINDOWS.filter(
    (row) => row.municipality === city && (!domain || row.programDomain === domain),
  );
  if (!targets.length) targets = REGISTRATION_WINDOWS.filter((row) => row.municipality === city);
  const season = body.match(/\b(fall|winter|spring|summer)\b/i)?.[1];
  if (season)
    targets = targets.filter((row) => row.cycleLabel.toLowerCase().includes(season.toLowerCase()));
  if (!targets.length) return null;
  if (city === 'toronto') {
    const postal = where?.postal ?? postalMentioned(body);
    const district = postal ? resolveDistrict(postal) : null;
    targets = district
      ? preferDistrictRows(targets, district)
      : targets.filter((row) => row.district == null);
    if (!targets.length)
      return 'Toronto registration dates vary by district. What is your postal code?';
  }
  const seen = new Set<string>();
  const found: Array<{ when: string; url: string }> = [];
  for (const target of targets) {
    const identity = `${target.sourceUrl}|${target.cycleLabel}|${target.district ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const reading = await reader(
      windowReadTarget({ ...target, district: target.district ?? null }),
      now,
    );
    const date =
      registrationDate(reading, false) ??
      (reading.status === 'verified'
        ? reading.dates.find((value) => value.kind === 'resident_open')
        : null);
    if (date && (season || !registrationHasOpened(reading, date, now)))
      found.push({
        when: `${date.kind === 'resident_open' ? 'Residents: ' : ''}${registrationWhen(reading, date)}`,
        url: reading.sourceUrl,
      });
    if (found.length) break;
  }
  const first = found[0];
  return first
    ? `The registration page says ${first.when}. ${first.url}`
    : `I couldn't verify the current registration date on the official page. ${targets[0]!.sourceUrl}`;
}

export async function liveRecMorningIntakeReply(
  input: {
    parentWords: string;
    pendingAsk: string;
    now?: Date;
    postal?: string | null;
    city?: string | null;
  },
  reader: RegistrationReader = createRegistrationReader(),
): Promise<string | null> {
  const reply = await liveRecMorningReply(
    input.parentWords,
    input.now ?? new Date(),
    {
      postal: input.postal,
      city: input.city,
    },
    reader,
  );
  if (reply === null) return null;
  const followup = recMorningReturnLine(input.pendingAsk);
  // Keep the date, source zone and outstanding ask; omit a long citation, never cut its URL.
  let joined = `${reply} ${followup}`;
  if (joined.length > INTAKE_MAX_REPLY_CHARS)
    joined = `${reply.replace(/\shttps:\/\/\S+$/, '')} ${followup}`;
  if (joined.length > INTAKE_MAX_REPLY_CHARS)
    throw new Error(
      `rec-morning intake reply is ${joined.length} chars, cap is ${INTAKE_MAX_REPLY_CHARS}`,
    );
  return joined;
}
