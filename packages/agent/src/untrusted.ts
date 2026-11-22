/**
 * VIL-560 · one mark for untrusted email, calendar and web content in a prompt.
 *
 * Spotlighting: an untrusted field at a wired call site enters the prompt wrapped the
 * same way, so the model can tell data from instructions. Not every prompt is wired
 * yet (VIL-560). Callers pass `enabled` from `isEnabled('untrusted-field-marking')`.
 * Off, the value is returned unchanged, so a dark flag does not re-key a cached prompt.
 */

export type UntrustedSource = 'email' | 'calendar' | 'web' | 'other';

/**
 * ASCII `<` and what a model could read as it: angle brackets and ornaments, the invisible
 * tag-block `<`, and the look-alikes U+02C2 and U+1438. A character that decomposes to one
 * of these (full-width, small and vertical forms, U+226E) is caught by its NFKD form.
 * Not `«`, which is ordinary French punctuation and folds to none of these.
 */
const TAG_OPENERS = new Set(
  '<\u2039\u3008\u300A\u27E8\u27EA\u276C\u276E\u2770\u2991\u29FC\u{E003C}\u02C2\u1438',
);
const MAY_OPEN_TAG = /[<\u0080-\u{10FFFF}]/gu;
const ESCAPED_OPENER = '&lt;';

function opensTag(character: string): boolean {
  return [...character.normalize('NFKD')].some((folded) => TAG_OPENERS.has(folded));
}

/**
 * Every character that could open a tag becomes `&lt;`, so a value holds no tag and so no
 * closer, in any spelling. Nothing else changes: `&` stays, so "Parks & Rec" never comes
 * back as `&amp;`.
 */
export function escapeTagOpeners(value: string): string {
  return value.replace(MAY_OPEN_TAG, (character) =>
    opensTag(character) ? ESCAPED_OPENER : character,
  );
}

/**
 * The form a gate compares a model's copy and its source in. The model read `&lt;` for `<`
 * and every look-alike, so it may hand back either: both sides take the one spelling `<`.
 */
export function comparableToMarked(enabled: boolean, text: string): string {
  return enabled ? escapeTagOpeners(text).replaceAll(ESCAPED_OPENER, '<') : text;
}

/** A model's answer with the escape undone, so what is kept or sent never holds `&lt;`. */
export function withoutMarkEscape<T>(enabled: boolean, answer: T): T {
  if (!enabled) return answer;
  return JSON.parse(JSON.stringify(answer).replaceAll(ESCAPED_OPENER, '<')) as T;
}

/** Quotes, brackets and newlines in a field name must not end the attribute or the tag. */
function escapeField(field: string): string {
  return field
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

/** Maps where a row came from (`events.source`), so a label never comes from content. */
export function untrustedSourceFor(origin: string): UntrustedSource {
  switch (origin) {
    case 'gmail':
    case 'email':
      return 'email';
    case 'gcal':
    case 'calendar':
      return 'calendar';
    case 'web':
    case 'page':
    case 'pdf':
      return 'web';
    default:
      return 'other';
  }
}

/**
 * A space, not a newline, around the value. In a JSON-encoded prompt a newline becomes a
 * literal `\n`, and its `n` removes the word boundary the telemetry scrubbers need to
 * catch an address or phone number at the start of the value.
 */
export function markUntrusted(source: UntrustedSource, field: string, value: string): string {
  return `<untrusted source="${source}" field="${escapeField(field)}"> ${escapeTagOpeners(value)} </untrusted>`;
}

/** The bytes a prompt should carry: marked when the flag is on, unchanged when it is off. */
export function presentUntrusted(
  enabled: boolean,
  source: UntrustedSource,
  field: string,
  value: string,
): string {
  return enabled ? markUntrusted(source, field, value) : value;
}

/** One mark around a JSON-able value, so its keys sit inside the mark with its strings. */
export function presentUntrustedJson(
  enabled: boolean,
  source: UntrustedSource,
  field: string,
  value: unknown,
): unknown {
  return enabled ? markUntrusted(source, field, JSON.stringify(value)) : value;
}
