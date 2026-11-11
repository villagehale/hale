/**
 * VIL-480 · An iMessage app card a parent sent in, read for the model.
 *
 * Linq's `message.received` carries an `imessage_app` part (app identity, `url`,
 * `layout`) in place of text. Dark, payload.ts keeps it as an unnamed `file`. Lit, this
 * turns the card's own visible words into one bracketed line the model can read. It is
 * a description of what arrived, not Hale's wording: nothing here is sent back.
 */

const LAYOUT_KEYS = [
  'caption',
  'subcaption',
  'trailing_caption',
  'trailing_subcaption',
  'image_title',
  'image_subtitle',
] as const;
const FIELD_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, FIELD_MAX) : null;
}

export function describeInboundAppCard(part: Record<string, unknown>): string | null {
  const layout = isRecord(part.layout) ? part.layout : {};
  const app = isRecord(part.app) ? part.app : {};
  const words = LAYOUT_KEYS.map((key) => clean(layout[key])).filter((v): v is string => !!v);
  const fallback = clean(part.fallback_text);
  if (words.length === 0 && fallback) words.push(fallback);
  let url: string | null = null;
  if (typeof part.url === 'string') {
    try {
      const parsed = new URL(part.url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password)
        url = parsed.toString();
    } catch {
      url = null;
    }
  }
  if (words.length === 0 && !url) return null;
  const appName = clean(app.name);
  const fields = [appName ? `app: ${appName}` : null, ...words, url].filter(Boolean);
  return `[iMessage app card · ${fields.join(' · ')}]`;
}
