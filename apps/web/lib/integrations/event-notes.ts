import type { FamilyEventNotes } from '@hale/db';

/**
 * VIL-468. Parking and what-to-bring facts from a calendar event's description.
 *
 * Only a line the organizer LABELLED is a fact ("Parking: lot B behind the rink",
 * "What to bring: skates, helmet"). Nothing is inferred from prose, so the reminder
 * model never receives a detail the event did not state; with no labelled line the
 * key is absent and the model says nothing about it. The raw description is never
 * returned or stored (rule #1), only the labelled values, each capped.
 *
 * This is the deterministic half. Model extraction from alert mail and provider pages
 * (email-alert.ts, fanout) changes the eval request shape and waits on the re-record
 * budget.
 */

const VALUE_MAX = 160;

const PARKING_LABEL = /^(?:parking(?:\s+info(?:rmation)?)?)\s*[:\-–—]\s*(.+)$/i;
const BRING_LABEL =
  /^(?:what\s+to\s+bring|things\s+to\s+bring|please\s+bring|to\s+bring|bring)\s*[:\-–—]\s*(.+)$/i;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Google descriptions are often HTML: line breaks become newlines, tags go. */
function plainLines(description: string): string[] {
  return description
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*•\-–]+/, '').trim())
    .filter((line) => line.length > 0);
}

function capped(value: string): string | undefined {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > VALUE_MAX ? `${clean.slice(0, VALUE_MAX - 1).trimEnd()}…` : clean;
}

export function extractEventNotes(description: string | null | undefined): FamilyEventNotes | null {
  if (!description) return null;
  const notes: FamilyEventNotes = {};
  for (const line of plainLines(description)) {
    const parking = notes.parking === undefined ? PARKING_LABEL.exec(line) : null;
    if (parking?.[1]) {
      const value = capped(parking[1]);
      if (value) notes.parking = value;
      continue;
    }
    const bring = notes.bring === undefined ? BRING_LABEL.exec(line) : null;
    if (bring?.[1]) {
      const value = capped(bring[1]);
      if (value) notes.bring = value;
    }
  }
  return notes.parking === undefined && notes.bring === undefined ? null : notes;
}

/** Same facts, same order: a mirror re-read with an unchanged description is not a change. */
export function sameEventNotes(
  a: FamilyEventNotes | null | undefined,
  b: FamilyEventNotes | null | undefined,
): boolean {
  return (a?.parking ?? null) === (b?.parking ?? null) && (a?.bring ?? null) === (b?.bring ?? null);
}
