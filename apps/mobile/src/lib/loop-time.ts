/**
 * Pure clock-string helpers for the F11 Sunday Loop time controls. Three
 * representations meet here: the wire carries 'HH:MM:SS', the native time picker
 * works in Date, and the PATCH takes 'HH:MM'. These bridge them, framework-free so
 * they're unit-tested. The 12-hour label mirrors ask-history's clock.
 */

/** 'HH:MM:SS' | 'HH:MM' → a Date today at that local wall-clock time (the picker's
 * value). Only hours/minutes are read; the calendar day is arbitrary. */
export function timeStringToDate(hms: string): Date {
  const [h, m] = hms.split(':');
  const d = new Date();
  d.setHours(Number(h), Number(m), 0, 0);
  return d;
}

/** A Date → 'HH:MM' (zero-padded, 24h) — the value the loop route accepts. */
export function dateToTimeValue(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** 'HH:MM:SS' | 'HH:MM' → a 12-hour display label ("9:30 PM"). */
export function timeStringToLabel(hms: string): string {
  const [h, m] = hms.split(':');
  const hour24 = Number(h);
  const minutes = m.padStart(2, '0');
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minutes} ${meridiem}`;
}
