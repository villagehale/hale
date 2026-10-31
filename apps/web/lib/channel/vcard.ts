import { normalizePhoneE164 } from '~/lib/channels/phone';

/**
 * VIL-482 — a `.vcf` a parent sent, read into fields for the coach.
 *
 * The bytes are not stored and are not shown to the model. A photo, a street, and a
 * birthday stay out: the use is name and number (and a few fields that say who the
 * person is), so Hale can offer a next step. Hale does not text the person. Nothing
 * in this file is wording a parent will see.
 */

const MAX_TEXT = 2_000_000;
/** How many cards from one file, and from one turn, Hale puts in front of the coach. */
export const MAX_CONTACT_CARDS = 3;
const MAX_PHONES = 4;
const MAX_EMAILS = 3;

const SKIP_TYPES = new Set([
  'voice',
  'internet',
  'pref',
  'preferred',
  'pcs',
  'msg',
  'bbs',
  'modem',
  'car',
  'isdn',
  'video',
]);

export interface ContactPhone {
  number: string;
  /** Canonical CA/US form. Null when the card's number is not one. */
  e164: string | null;
  label: string | null;
}

export interface ContactEmail {
  address: string;
  label: string | null;
}

/** What the coach sees for one card. Absent keys were not on the card. */
export interface CoachContact {
  name: string | null;
  phones: ContactPhone[];
  emails?: ContactEmail[];
  org?: string;
  title?: string;
  /** City and region only. A street on the card is not copied. */
  place?: string;
}

export interface ParsedContactFile {
  cards: CoachContact[];
  /** The file held more than {@link MAX_CONTACT_CARDS} cards, or the text was cut for size. */
  truncated: boolean;
}

interface Prop {
  group: string | null;
  name: string;
  types: string[];
  pref: boolean;
  value: string;
}

export function parseContactCards(raw: string): ParsedContactFile {
  let text = raw;
  let truncated = false;
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT);
    truncated = true;
  }

  const lines = joinQuotedPrintableBreaks(unfold(text));
  const cards: CoachContact[] = [];
  let inCard = false;
  let props: Prop[] = [];
  const labels = new Map<string, string>();

  const flush = () => {
    const card = buildCard(props, labels);
    props = [];
    labels.clear();
    if (!card) return;
    if (cards.length >= MAX_CONTACT_CARDS) {
      truncated = true;
      return;
    }
    cards.push(card);
  };

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const value = parsed.value.trim();
    if (parsed.name === 'BEGIN' && value.toUpperCase() === 'VCARD') {
      if (inCard) flush();
      if (cards.length >= MAX_CONTACT_CARDS) {
        truncated = true;
        inCard = false;
        continue;
      }
      inCard = true;
      props = [];
      labels.clear();
      continue;
    }
    if (!inCard) continue;
    if (parsed.name === 'END' && value.toUpperCase() === 'VCARD') {
      flush();
      inCard = false;
      continue;
    }

    const params = parseParams(parsed.paramText);
    const decoded = decodePropertyValue(parsed.value, params.encoding, params.charset);
    if (decoded == null) continue;
    if (parsed.name === 'X-ABLABEL' && parsed.group) {
      const label = clip(decoded, 40);
      if (label) labels.set(parsed.group, label);
      continue;
    }
    if (!KEPT.has(parsed.name)) continue;
    props.push({
      group: parsed.group,
      name: parsed.name,
      types: params.types,
      pref: params.pref,
      value: decoded,
    });
  }
  if (inCard) flush();
  return { cards, truncated };
}

// NOTE is not kept: it is free text the sender wrote, and it reached the coach as
// if it were a field. Name and number are the use (Devin SEC_0003).
const KEPT = new Set(['FN', 'N', 'NICKNAME', 'TEL', 'EMAIL', 'ORG', 'TITLE', 'ADR']);

function buildCard(
  props: readonly Prop[],
  labels: ReadonlyMap<string, string>,
): CoachContact | null {
  let name: string | null = null;
  let nickname: string | null = null;
  const phones: Array<ContactPhone & { pref: boolean }> = [];
  const emails: Array<ContactEmail & { pref: boolean }> = [];
  let org: string | null = null;
  let title: string | null = null;
  let place: string | null = null;
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();

  for (const prop of props) {
    const label = labelFor(prop.group ? (labels.get(prop.group) ?? null) : null, prop.types);
    if (prop.name === 'FN') {
      const formatted = clip(prop.value, 120);
      if (formatted) name = formatted;
    } else if (prop.name === 'N' && !name) name = nameFromN(prop.value);
    else if (prop.name === 'NICKNAME' && !nickname) nickname = clip(prop.value, 120);
    else if (prop.name === 'TEL') {
      const phone = cleanPhone(prop.value);
      if (!phone) continue;
      const key = phone.e164 ?? phone.number;
      if (seenPhones.has(key)) continue;
      seenPhones.add(key);
      phones.push({ ...phone, label, pref: prop.pref });
    } else if (prop.name === 'EMAIL') {
      const address = cleanEmail(prop.value);
      if (!address) continue;
      const key = address.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      emails.push({ address, label, pref: prop.pref });
    } else if (prop.name === 'ORG' && !org) org = formatOrg(prop.value);
    else if (prop.name === 'TITLE' && !title) title = clip(prop.value, 80);
    else if (prop.name === 'ADR' && !place) place = placeFromAdr(prop.value);
  }

  if (!name && nickname) name = nickname;
  if (!name && phones.length === 0 && emails.length === 0) return null;

  // Cap after ordering, so a preferred number fifth on the card is still kept.
  // Array.prototype.sort is stable: equal-pref entries keep card order.
  phones.sort((a, b) => Number(b.pref) - Number(a.pref));
  emails.sort((a, b) => Number(b.pref) - Number(a.pref));
  const card: CoachContact = {
    name,
    phones: phones.slice(0, MAX_PHONES).map(({ number, e164, label }) => ({ number, e164, label })),
  };
  if (emails.length > 0) {
    card.emails = emails.slice(0, MAX_EMAILS).map(({ address, label }) => ({ address, label }));
  }
  if (org) card.org = org;
  if (title) card.title = title;
  if (place) card.place = place;
  return card;
}

function nameFromN(value: string): string | null {
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] = splitStructured(
    value,
  ).map((part) => part.trim());
  return clip([prefix, given, additional, family, suffix].filter(Boolean).join(' '), 120);
}

/** Locality, region, country. Street, postal code, and post-office box are dropped. */
function placeFromAdr(value: string): string | null {
  const parts = splitStructured(value).map((part) => part.trim());
  return clip([parts[3], parts[4], parts[6]].filter(Boolean).join(', '), 80);
}

function formatOrg(value: string): string | null {
  const parts = splitStructured(value)
    .map((part) => part.trim())
    .filter(Boolean);
  return clip(parts.join(', '), 80);
}

function labelFor(abLabel: string | null, types: readonly string[]): string | null {
  if (abLabel) return abLabel;
  for (const type of types) {
    if (SKIP_TYPES.has(type.toLowerCase())) continue;
    return clip(type.toLowerCase(), 40);
  }
  return null;
}

/**
 * An extension is not part of the number. `tel:+1416…;ext=123`, `… x123`, `… ext. 123`
 * keep the base number only; the extension digits are never appended to it.
 */
const EXTENSION = /\s*(?:[,;]|ext\.?|extension|x|#)\s*\d+\s*$/i;

function cleanPhone(raw: string): { number: string; e164: string | null } | null {
  let trimmed = raw.trim().replace(/^tel:/i, '').trim();
  // tel: URI parameters (`;ext=`, `;phone-context=`, `;isub=`) are not digits of the number.
  const uriParams = trimmed.indexOf(';');
  if (uriParams >= 0) trimmed = trimmed.slice(0, uriParams).trim();
  trimmed = trimmed.replace(EXTENSION, '').trim();
  if (!trimmed || trimmed.length > 40) return null;
  const e164 = normalizePhoneE164(trimmed);
  if (e164) return { number: e164, e164 };
  const compact = trimmed.replace(/[^\d+]/g, '');
  const digits = compact.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || compact.length > 16) return null;
  return { number: compact, e164: null };
}

function cleanEmail(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^mailto:/i, '')
    .trim();
  if (value.length < 3 || value.length > 120) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

function clip(value: string, max: number): string | null {
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    cleaned += code <= 31 || code === 127 ? ' ' : char;
  }
  const flat = cleaned.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length <= max ? flat : flat.slice(0, max);
}

function unfold(raw: string): string[] {
  const text = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && current) {
      current += line.slice(1);
      continue;
    }
    if (current) lines.push(current);
    current = line;
  }
  if (current) lines.push(current);
  return lines;
}

/** Quoted-printable soft breaks are a trailing `=` plus a line that is not a new property. */
function joinQuotedPrintableBreaks(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    while (line.endsWith('=') && i + 1 < lines.length && !lines[i + 1]?.includes(':')) {
      line = line.slice(0, -1) + (lines[i + 1] ?? '');
      i++;
    }
    out.push(line);
  }
  return out;
}

function parseLine(
  line: string,
): { group: string | null; name: string; paramText: string; value: string } | null {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = indexOfUnquoted(left, ';');
  const head = (semi === -1 ? left : left.slice(0, semi)).trim();
  const paramText = semi === -1 ? '' : left.slice(semi);
  const dot = head.indexOf('.');
  let group: string | null = null;
  let name = head;
  if (dot > 0) {
    group = head.slice(0, dot);
    name = head.slice(dot + 1);
  }
  if (!/^[A-Za-z0-9-]+$/.test(name)) return null;
  if (group && !/^[A-Za-z0-9-]+$/.test(group)) return null;
  return { group, name: name.toUpperCase(), paramText, value };
}

function parseParams(paramText: string): {
  types: string[];
  encoding: string | null;
  charset: string | null;
  pref: boolean;
} {
  const types: string[] = [];
  let encoding: string | null = null;
  let charset: string | null = null;
  let pref = false;
  const body = paramText.startsWith(';') ? paramText.slice(1) : paramText;
  if (!body) return { types, encoding, charset, pref };
  for (const part of splitParams(body)) {
    const eq = indexOfUnquoted(part, '=');
    if (eq === -1) {
      const token = unquote(part.trim());
      if (!token) continue;
      if (token.toLowerCase() === 'pref') pref = true;
      else types.push(token);
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = unquote(part.slice(eq + 1).trim());
    if (key === 'encoding') encoding = value.toLowerCase();
    else if (key === 'charset') charset = value.toLowerCase();
    else if (key === 'pref') pref = value !== '0';
    else if (key === 'type') {
      for (const token of value.split(',')) {
        const trimmed = token.trim();
        if (!trimmed) continue;
        if (trimmed.toLowerCase() === 'pref') pref = true;
        else types.push(trimmed);
      }
    }
  }
  return { types, encoding, charset, pref };
}

function decodePropertyValue(
  raw: string,
  encoding: string | null,
  charset: string | null,
): string | null {
  if (encoding === 'b' || encoding === 'base64') return null;
  if (encoding === 'quoted-printable' || encoding === 'qp') {
    const bytes = decodeQuotedPrintable(raw);
    const text =
      charset === 'iso-8859-1' || charset === 'latin1'
        ? bytes.toString('latin1')
        : bytes.toString('utf8');
    return unescapeVcard(text);
  }
  return unescapeVcard(raw);
}

function decodeQuotedPrintable(value: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(value.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function unescapeVcard(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1] ?? '';
      if (next === 'n' || next === 'N') out += '\n';
      else if (next === ',' || next === ';' || next === '\\') out += next;
      else out += next;
      i++;
      continue;
    }
    out += value[i];
  }
  return out;
}

function splitStructured(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      current += value.slice(i, i + 2);
      i++;
      continue;
    }
    if (value[i] === ';') {
      parts.push(unescapeVcard(current));
      current = '';
      continue;
    }
    current += value[i];
  }
  parts.push(unescapeVcard(current));
  return parts;
}

function splitParams(body: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      quoted = !quoted;
      current += c;
      continue;
    }
    if (c === ';' && !quoted) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current) out.push(current);
  return out;
}

function indexOfUnquoted(value: string, target: string): number {
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === target) return i;
  }
  return -1;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
