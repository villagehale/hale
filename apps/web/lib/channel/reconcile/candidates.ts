import type { ClaimRowLabel } from './claim-label';

/**
 * VIL-581 · the rows a claim may cite, and the names the model cites them by.
 *
 * The alias enum is the same 124 values on every call, so the output grammar never
 * changes per request. The per-call map is built only from rows read under this
 * family's id: an alias that is not in it backs nothing, whatever the model says —
 * another family's row, an earlier turn's alias, an invented one.
 *
 * The projection is all the model sees of a row: an alias, a kind, a state, a label and
 * a family-local time or a host. Never a family, user, child or row id, a URL or path,
 * or a place. A label is a {@link ClaimRowLabel}, which only claim-label.ts can make: a
 * 13+ child's or a sensitive calendar row is "A private calendar item" before it can
 * be a row here at all.
 *
 * The projection is also where size is bounded: a label and a host are cut by code
 * point, never mid-surrogate, so one pathological row cannot crowd the request.
 */

/** A label is a short phrase; this is room for any real one. */
export const CLAIM_ROW_MAX_WHAT_CHARS = 160;
/** The DNS name limit. */
export const CLAIM_ROW_MAX_HOST_CHARS = 253;

export const CLAIM_ROW_SLOTS = {
  e: 50,
  s: 20,
  c: 5,
  g: 10,
  q: 5,
  w: 1,
  r: 10,
  m: 10,
  x: 10,
} as const;
type Slot = keyof typeof CLAIM_ROW_SLOTS | 'p1' | 'p2';

export type ClaimRowAlias =
  | 'none'
  | `e${number}`
  | `s${number}`
  | `c${number}`
  | `g${number}`
  | `q${number}`
  | `w${number}`
  | `r${number}`
  | `m${number}`
  | `x${number}`
  | 'p1'
  | 'p2';

export const CLAIM_ROW_ALIASES: readonly ClaimRowAlias[] = [
  'none',
  ...(Object.entries(CLAIM_ROW_SLOTS) as Array<[keyof typeof CLAIM_ROW_SLOTS, number]>).flatMap(
    ([slot, cap]) => Array.from({ length: cap }, (_, i) => `${slot}${i + 1}` as ClaimRowAlias),
  ),
  'p1',
  'p2',
];

export type ClaimCandidateRow =
  | {
      familyId: string;
      source: 'calendar';
      kind: 'scheduled_event';
      what: ClaimRowLabel;
      startsAt: Date;
    }
  | { familyId: string; source: 'parent_stated'; kind: 'scheduled_event'; what: ClaimRowLabel }
  | {
      familyId: string;
      source: 'open_commitment';
      kind: 'registration_watch' | 'activity_followup';
      what: ClaimRowLabel;
    }
  | {
      familyId: string;
      source: 'watched_page';
      kind: 'spot_watch';
      what: ClaimRowLabel;
      host: string;
    }
  | {
      familyId: string;
      source: 'live_sequence';
      kind: 'registration_watch';
      what: ClaimRowLabel;
      opensAt: Date | null;
    }
  | {
      familyId: string;
      source: 'mintable_window';
      kind: 'registration_watch';
      what: ClaimRowLabel;
      opensForFamilyAt: Date;
    }
  | { familyId: string; source: 'pending'; kind: 'activity_followup'; what: ClaimRowLabel }
  | { familyId: string; source: 'pending'; kind: 'spot_watch'; what: ClaimRowLabel }
  /** A registration Hale's own signup run finished with a confirmation. */
  | { familyId: string; source: 'signup_confirmed'; kind: 'registration_done'; what: ClaimRowLabel }
  /** A booking a provider's confirmation email recorded, not called off since. */
  | {
      familyId: string;
      source: 'booking';
      kind: 'registration_done';
      what: ClaimRowLabel;
      startsAt: Date;
    }
  /** The parent said the child got in (registration_sequences.outcome). */
  | { familyId: string; source: 'reported_outcome'; kind: 'registration_done'; what: ClaimRowLabel }
  /** A send that left: the provider took it, and `delivered` when it said it arrived. */
  | {
      familyId: string;
      source: 'send_receipt';
      kind: 'send_done';
      what: ClaimRowLabel;
      sentAt: Date;
      delivered: boolean;
    }
  /** Something removed or called off: a calendar row, a booking, a watch, a signup plan.
   * `startsAt` is when it was going to happen, when it had a time. */
  | {
      familyId: string;
      source: 'cancelled';
      kind: 'cancelled';
      what: ClaimRowLabel;
      startsAt: Date | null;
    };

export interface ProjectedRow {
  a: ClaimRowAlias;
  kind: ClaimCandidateRow['kind'];
  state:
    | 'open'
    | 'pending'
    | 'mintable'
    | 'live'
    | 'confirmed'
    | 'sent'
    | 'delivered'
    | 'cancelled';
  what: string;
  when?: string;
  host?: string;
  source?: 'parent_stated' | 'confirmation_email' | 'hale_signup';
}

const BUILT: unique symbol = Symbol('ClaimCandidateSet');

export interface ClaimCandidateSet {
  readonly [BUILT]: true;
  readonly familyId: string;
  readonly byAlias: ReadonlyMap<ClaimRowAlias, ClaimCandidateRow>;
  /** What the model sees. */
  readonly projected: readonly ProjectedRow[];
  /** Rows dropped past a slot's cap. Named, never silent: a claim about one is refused. */
  readonly capped: readonly { slot: string; dropped: number }[];
}

/** A row read under another family's id reached the builder: a bug, never masked. */
export class ForeignCandidateRow extends Error {
  constructor() {
    super('claim candidates: a row from another family was offered');
    this.name = 'ForeignCandidateRow';
  }
}

function slotOf(row: ClaimCandidateRow): Slot {
  switch (row.source) {
    case 'calendar':
      return 'e';
    case 'parent_stated':
      return 's';
    case 'open_commitment':
      return 'c';
    case 'watched_page':
      return 'g';
    case 'live_sequence':
      return 'q';
    case 'mintable_window':
      return 'w';
    case 'pending':
      return row.kind === 'activity_followup' ? 'p1' : 'p2';
    case 'signup_confirmed':
    case 'booking':
    case 'reported_outcome':
      return 'r';
    case 'send_receipt':
      return 'm';
    case 'cancelled':
      return 'x';
  }
}

function capOf(slot: Slot): number {
  return slot === 'p1' || slot === 'p2' ? 1 : CLAIM_ROW_SLOTS[slot];
}

function aliasFor(slot: Slot, ordinal: number): ClaimRowAlias {
  return slot === 'p1' || slot === 'p2' ? slot : (`${slot}${ordinal}` as ClaimRowAlias);
}

function codePoints(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join('') : text;
}

function project(row: ClaimCandidateRow, a: ClaimRowAlias, when: (at: Date) => string) {
  const base = { a, kind: row.kind, what: codePoints(row.what, CLAIM_ROW_MAX_WHAT_CHARS) };
  switch (row.source) {
    case 'calendar':
      return { ...base, state: 'open', when: when(row.startsAt) } satisfies ProjectedRow;
    case 'parent_stated':
      return { ...base, state: 'open', source: 'parent_stated' } satisfies ProjectedRow;
    case 'open_commitment':
      return { ...base, state: 'open' } satisfies ProjectedRow;
    case 'watched_page':
      return {
        ...base,
        state: 'open',
        host: codePoints(row.host, CLAIM_ROW_MAX_HOST_CHARS),
      } satisfies ProjectedRow;
    case 'live_sequence':
      return row.opensAt
        ? ({ ...base, state: 'live', when: when(row.opensAt) } satisfies ProjectedRow)
        : ({ ...base, state: 'live' } satisfies ProjectedRow);
    case 'mintable_window':
      return {
        ...base,
        state: 'mintable',
        when: when(row.opensForFamilyAt),
      } satisfies ProjectedRow;
    case 'pending':
      return { ...base, state: 'pending' } satisfies ProjectedRow;
    case 'signup_confirmed':
      return { ...base, state: 'confirmed', source: 'hale_signup' } satisfies ProjectedRow;
    case 'booking':
      return {
        ...base,
        state: 'confirmed',
        source: 'confirmation_email',
        when: when(row.startsAt),
      } satisfies ProjectedRow;
    case 'reported_outcome':
      return { ...base, state: 'confirmed', source: 'parent_stated' } satisfies ProjectedRow;
    case 'send_receipt':
      return {
        ...base,
        state: row.delivered ? 'delivered' : 'sent',
        when: when(row.sentAt),
      } satisfies ProjectedRow;
    case 'cancelled':
      return row.startsAt
        ? ({ ...base, state: 'cancelled', when: when(row.startsAt) } satisfies ProjectedRow)
        : ({ ...base, state: 'cancelled' } satisfies ProjectedRow);
  }
}

export function buildClaimCandidates(
  familyId: string,
  rows: readonly ClaimCandidateRow[],
  timeZone: string,
): ClaimCandidateSet {
  const format = new Intl.DateTimeFormat('en', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const when = (at: Date) => format.format(at);
  const used = new Map<Slot, number>();
  const dropped = new Map<Slot, number>();
  const byAlias = new Map<ClaimRowAlias, ClaimCandidateRow>();
  const projected: ProjectedRow[] = [];
  for (const row of rows) {
    if (row.familyId !== familyId) throw new ForeignCandidateRow();
    const slot = slotOf(row);
    const ordinal = (used.get(slot) ?? 0) + 1;
    if (ordinal > capOf(slot)) {
      dropped.set(slot, (dropped.get(slot) ?? 0) + 1);
      continue;
    }
    used.set(slot, ordinal);
    const a = aliasFor(slot, ordinal);
    byAlias.set(a, row);
    projected.push(project(row, a, when));
  }
  const capped = [...dropped].map(([slot, count]) => ({ slot, dropped: count }));
  for (const entry of capped) {
    console.warn({ event: 'claim_read_candidates_capped', ...entry }, 'claim reader: rows capped');
  }
  return { [BUILT]: true, familyId, byAlias, projected, capped };
}
