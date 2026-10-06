import type { ReplyLanguage } from '~/lib/channel/language';
import { formatDayHeading } from '~/lib/format/datetime';
import { foldOutboundLine } from './outbound-line';

/**
 * The date a receipt must copy, already in the parent's language and already
 * folded onto GSM-7.
 *
 * English stays `Sunday, Oct 4 at 9:00 a.m.`. French is the fr-CA calendar
 * day with the clock after à, and a zero minute dropped: `dimanche 4 oct. à
 * 9 h`. août folds to aout, because lowercase û is not in the alphabet and
 * the letter under it has to survive.
 */
export function offerWhenLabel(
  startsAt: Date,
  timeZone: string,
  now: Date,
  language: ReplyLanguage,
): string {
  if (language === 'fr') return foldOutboundLine(frenchWhen(startsAt, timeZone, now));
  const clock = new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(startsAt);
  return foldOutboundLine(`${formatDayHeading(startsAt, timeZone, now)} at ${clock}`);
}

function frenchWhen(startsAt: Date, timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('fr-CA', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    hourCycle: 'h23',
  }).formatToParts(startsAt);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  const minute = part('minute');
  const clock = minute === '00' ? `${part('hour')} h` : `${part('hour')} h ${minute}`;
  const yearOf = (date: Date): string =>
    new Intl.DateTimeFormat('en-CA', { year: 'numeric', timeZone }).format(date);
  const year = yearOf(startsAt) === yearOf(now) ? '' : ` ${yearOf(startsAt)}`;
  return `${part('weekday')} ${part('day')} ${part('month')}${year} à ${clock}`;
}
