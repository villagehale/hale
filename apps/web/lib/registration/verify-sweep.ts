import { createHash } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { type Database, type Municipality, type ProgramDomain, schema } from '@hale/db';
import { and, asc, eq, gte, lt, lte } from 'drizzle-orm';
import type { Resend } from 'resend';
import { founderAddress } from '~/lib/auth/founder-signal';
import { createResendTransport } from '~/lib/channel/resend-transport';
import {
  type ProviderAbort,
  type ProviderAlertSender,
  providerPreflight,
} from '~/lib/monitoring/provider-health';
import { DISCOVERY_TARGETS, type DiscoveryTarget } from './discovery-targets';
import {
  type CycleIdentity,
  type ExtractedWindow,
  REGISTRATION_TIME_ZONE,
  type StoredWindow,
  type VerifyOutcome,
  type VerifyField,
  compareWindow,
  corroborationFailure,
  extractPublishedWindow,
  isTrustworthyFind,
  withoutInferredEvidence,
} from './verify-window';
import { inferredFieldsFor } from './registration-windows';

/**
 * VIL-259 — the weekly registration re-verify sweep. M1 (VIL-236) specified this
 * loop and shipped without it: the dataset is hand-verified once and then trusted
 * forever, so a municipality that moves a date goes stale silently, and Toronto's
 * "to be announced" fall dates would never be noticed when they finally appear.
 *
 * A WRONG REGISTRATION TIME IS THE ONE ERROR THIS RADAR CANNOT MAKE. Everything
 * below follows from that:
 *
 *   CONFIRMED bumps `verified_at` and says nothing. That is the only write this
 *     sweep performs, on the only column it may touch.
 *   DISCREPANCY writes NOTHING — not the new date, and not `verified_at` either,
 *     so an unconfirmed row stays visibly stale instead of looking freshly
 *     checked. It becomes a founder-digest line carrying both instants, the
 *     source URL and the page's own words, for a human to decide.
 *   UNVERIFIED (page changed, cycle gone, model unsure, fetch failed) is a
 *     "needs a human look" line. Never a guess, never a silent pass.
 *
 * Plus a DISCOVERY leg for the two known gaps — Toronto's unpublished seasonal
 * dates and Halton Hills' missing cycle — which suggests an addition and never
 * makes one. The dataset stays hand-verified by construction.
 *
 * Isolation (rule #8): one municipality's page failing is that row's recorded
 * outcome, never the sweep's. Nothing here is swallowed into a clean success.
 */

/** The rate_limits `route` the weekly claim lives under, mirroring the provider
 * incident claim: an ops event with no family, made exactly-once by the table's
 * (identifier, route, window_start) unique index. */
export const REGISTRATION_VERIFY_ROUTE = 'ops:registration-verify';

/**
 * How many stored windows one run may check. Sized against the function's 300s
 * ceiling, not against the dataset: each row costs one Sonnet read of a page
 * (~6s), so 24 rows is roughly 150s of model time with room for the fetches and
 * the discovery leg. The dataset is ~20 upcoming rows today.
 *
 * Rows are taken in `open_at` order, so if the dataset ever outgrows this the
 * sweep spends its budget on the SOONEST deadlines — the ones a family is about
 * to act on — and the far-future rows wait a week. Pages are fetched once per
 * URL regardless (see `pageCache`), so the cap bounds model calls, not politeness.
 */
export const MAX_WINDOWS_PER_RUN = 24;

/** Per-URL network budget. Municipal sites are slow; 15s is generous for a page
 * read and short enough that a hung host cannot eat the function's 300s. */
export const PAGE_FETCH_TIMEOUT_MS = 15_000;

/**
 * A response bigger than this is not a municipal page, and is REFUSED rather than
 * trimmed. The distinction is the whole of VIL-261: the previous code sliced the raw
 * html at 500 KB before stripping it, and vaughan.ca is ~890 KB of markup whose "Key
 * Dates" block starts at offset ~837 K — so a successful fetch became a page that
 * appears to publish nothing. A truncation that silently removes the answer is worse
 * than a failure, because "this town has not announced its dates" is a plausible,
 * unquestionable thing for the sweep to conclude. A refusal is a `fetch_failed` line
 * a human reads.
 */
export const MAX_PAGE_BYTES = 4_000_000;

/**
 * How much READABLE text one page may contribute to a model call. Markup is most of
 * a municipal page: the largest in the dataset (Vaughan) strips 890 KB of html down
 * to 44 K of text, and the smallest (Oakville) to 2.5 K. This ceiling therefore
 * bounds context and cost without being reachable by anything real.
 */
export const MAX_PAGE_TEXT_CHARS = 200_000;

/** The network seam, injected so no test reaches a municipal site. */
export type FetchPage = (url: string) => Promise<string>;

/** Crude tag strip — good enough for a model read, not a rendering surface.
 * Same approach as the sentinel's html fallback. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DO NOT ADD A DESCRIPTIVE User-Agent HERE. It is the obvious "identify yourself
 * politely" change and it costs us a municipality. Measured against the live sites
 * on 2026-08-02: vaughan.ca sits behind an Akamai bot manager that answers 403 to
 * `Mozilla/5.0 (compatible; HaleRegistrationVerifier/1.0; +https://villagehale.com)`
 * and 200 to the very same request under Node's default `user-agent: node`. It also
 * 403s curl and its own /robots.txt, so there is no stated policy to read and no
 * identified client it will accept. The failure that change causes is invisible —
 * one more `fetch_failed` row that reads like a flaky network.
 */
const PAGE_FETCH_HEADERS = { Accept: 'text/html,application/xhtml+xml' } as const;

/**
 * The bytes as the server sent them — the timeout, the status throw, the 4 MB refusal
 * and the redirect refusal, and nothing else.
 *
 * IT IS THE PRIMITIVE BECAUSE THE STRIP IS NOT UNIVERSAL (VIL-337). A PerfectMind
 * course page says nothing readable about availability — its visible text strips to
 * ~500 characters of "Course Dates ... Load more..." — and carries the whole record as
 * a JSON object literal inside a `<script>` block, which `stripHtml` deletes. A watcher
 * built on `createFetchPage` could therefore never see a spot open. Both callers must
 * still inherit the refusals, so they live down here rather than beside the strip.
 *
 * A REDIRECT IS A FAILURE, NOT A HOP. The caller checked one host against a registry
 * before it ever got here — the spot watcher's sanitizer (channel/spots/url.ts) is the
 * strict case — and then polls that one URL every ten minutes for sixty days. Following
 * a 302 would keep answering 200 from an origin nobody approved, so the standing poll
 * would move hosts and go on looking healthy. `redirect: 'error'` makes that a named
 * fetch failure the sweep already knows how to report.
 */
export function createFetchBody(timeoutMs = PAGE_FETCH_TIMEOUT_MS): FetchPage {
  return async (url: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: PAGE_FETCH_HEADERS,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`page fetch ${url} → HTTP ${res.status}`);
      }
      // THE DECLARED LENGTH FIRST, so a body too large to be a page is refused before it
      // is buffered. This primitive runs inside an inbound SMS turn on a URL a parent
      // pasted, and an origin that answers with a video would otherwise pull the whole
      // thing into memory to be told it was too big. The read below stays as the ceiling
      // for every origin that declares no length at all — most of them, under chunked
      // transfer encoding — so nothing here is a substitute for it.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
        throw new Error(
          `page fetch ${url} → ${declared} chars exceeds the ${MAX_PAGE_BYTES} page ceiling`,
        );
      }
      const body = await res.text();
      if (body.length > MAX_PAGE_BYTES) {
        throw new Error(
          `page fetch ${url} → ${body.length} chars exceeds the ${MAX_PAGE_BYTES} page ceiling`,
        );
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createFetchPage(timeoutMs = PAGE_FETCH_TIMEOUT_MS): FetchPage {
  const fetchBody = createFetchBody(timeoutMs);
  return async (url: string) => {
    // Strip FIRST, then bound. Bounding the markup throws away the dates it was
    // wrapped in; bounding the text bounds what the model actually reads.
    const text = stripHtml(await fetchBody(url));
    return text.length > MAX_PAGE_TEXT_CHARS ? text.slice(0, MAX_PAGE_TEXT_CHARS) : text;
  };
}

// ── the known gaps ───────────────────────────────────────────────────────────
// The list itself lives in discovery-targets.ts, a leaf the radar can read without
// dragging this module's model client and mail transport into a stranger's first text.
// Re-exported here because this is where the sweep's callers already look for it.

export { type DiscoveryTarget, DISCOVERY_TARGETS } from './discovery-targets';

// ── results ──────────────────────────────────────────────────────────────────

export interface RowResult {
  windowId: string;
  municipality: Municipality;
  programDomain: ProgramDomain;
  cycleLabel: string;
  sourceUrl: string;
  outcome: VerifyOutcome;
  /** The underlying error text, when the outcome was a failure rather than a read. */
  detail?: string;
}

export interface DiscoveryResult {
  target: DiscoveryTarget;
  /** True only for a corroborated, confident find — the bar a suggestion must clear. */
  published: boolean;
  reading: ExtractedWindow | null;
  /** The URL the published reading came from. Null when no page cleared the bar. */
  sourceUrl: string | null;
  detail?: string;
  /**
   * A prior `published` reading of this same target is at least
   * {@link DISCOVERY_ESCALATE_AFTER_MS} old, and the target is still on the
   * list — the gap did not close.
   */
  escalated: boolean;
}

/** How long a published discovery may sit unseeded before the digest escalates. */
export const DISCOVERY_ESCALATE_AFTER_MS = 7 * 24 * 3_600_000;

/** sha256 of the page text a discovery reading was taken from. */
export function discoveryPageHash(pageText: string): string {
  return createHash('sha256').update(pageText).digest('hex');
}

/** One persisted discovery reading. `readAt` is the sweep's clock. */
export interface DiscoveryReadingInsert {
  municipality: Municipality;
  programDomain: ProgramDomain;
  cycleLabel: string;
  sourceUrl: string;
  published: boolean;
  reading: ExtractedWindow | null;
  pageHash: string | null;
  readAt: Date;
}

/** A published reading old enough to escalate, reduced to the identity the
 * digest matches on. */
export interface PriorPublishedDiscovery {
  municipality: string;
  programDomain: string;
  cycleLabel: string;
  readAt: Date;
}

/**
 * Append this run's discovery readings. Empty is a no-op, not a silent skip of
 * a configured writer — there was nothing to record.
 */
export async function recordDiscoveryReadings(
  database: Database,
  readings: readonly DiscoveryReadingInsert[],
): Promise<void> {
  if (readings.length === 0) return;
  await database.insert(schema.registrationDiscoveryReadings).values(
    readings.map((reading) => ({
      municipality: reading.municipality,
      programDomain: reading.programDomain,
      cycleLabel: reading.cycleLabel,
      sourceUrl: reading.sourceUrl,
      published: reading.published,
      reading: reading.reading as Record<string, unknown> | null,
      pageHash: reading.pageHash,
      readAt: reading.readAt,
    })),
  );
}

/**
 * Published readings at least 7 days old. The escalation is a comparison
 * against these, not a flag on the row: a target that is still on the list
 * this Monday is still open.
 */
export async function loadPriorPublishedDiscoveries(
  database: Database,
  now: Date,
): Promise<PriorPublishedDiscovery[]> {
  const cutoff = new Date(now.getTime() - DISCOVERY_ESCALATE_AFTER_MS);
  return database
    .select({
      municipality: schema.registrationDiscoveryReadings.municipality,
      programDomain: schema.registrationDiscoveryReadings.programDomain,
      cycleLabel: schema.registrationDiscoveryReadings.cycleLabel,
      readAt: schema.registrationDiscoveryReadings.readAt,
    })
    .from(schema.registrationDiscoveryReadings)
    .where(
      and(
        eq(schema.registrationDiscoveryReadings.published, true),
        lte(schema.registrationDiscoveryReadings.readAt, cutoff),
      ),
    );
}

export interface RegistrationVerifySummary {
  checked: number;
  confirmed: number;
  discrepancies: number;
  unverified: number;
  rows: RowResult[];
  discoveries: DiscoveryResult[];
  /** Set when the run did nothing on purpose: the week was already swept, or
   * there is no model client to read a page with. Nothing was fetched or spent. */
  skipped?: 'already_ran_this_week' | 'no_model_client';
  /** Set when the provider pre-flight cancelled the window. */
  aborted?: ProviderAbort;
}

// ── database edges ───────────────────────────────────────────────────────────

/**
 * The windows worth re-verifying: the ones a family could still act on. A cycle
 * whose open has passed cannot be got wrong any more, and re-reading it would
 * spend money to learn nothing.
 */
export async function loadUpcomingWindows(
  database: Database,
  now: Date,
  limit: number,
): Promise<StoredWindow[]> {
  return database
    .select({
      id: schema.registrationWindows.id,
      municipality: schema.registrationWindows.municipality,
      programDomain: schema.registrationWindows.programDomain,
      cycleLabel: schema.registrationWindows.cycleLabel,
      district: schema.registrationWindows.district,
      previewAt: schema.registrationWindows.previewAt,
      residentOpenAt: schema.registrationWindows.residentOpenAt,
      openAt: schema.registrationWindows.openAt,
      sourceUrl: schema.registrationWindows.sourceUrl,
      verifiedAt: schema.registrationWindows.verifiedAt,
    })
    .from(schema.registrationWindows)
    .where(gte(schema.registrationWindows.openAt, now))
    .orderBy(asc(schema.registrationWindows.openAt))
    .limit(limit);
}

/**
 * The sweep's only write TO THE DATASET. `verified_at` and `updated_at` — never a
 * date, never notes. Narrow on purpose: this function is the entire surface through
 * which a re-verify run can touch the dataset, so "the sweep cannot change a date" is
 * checkable by reading one query. (The run's own tally lands in a separate ops table —
 * see {@link recordVerifyRun} — which touches no registration row at all.)
 */
export async function markWindowVerified(
  database: Database,
  windowId: string,
  now: Date,
): Promise<void> {
  await database
    .update(schema.registrationWindows)
    .set({ verifiedAt: now, updatedAt: now })
    .where(eq(schema.registrationWindows.id, windowId));
}

const WEEK_MS = 7 * 24 * 3_600_000;
/** Jan 1 1970 was a Thursday; shifting by three days puts bucket boundaries on
 * Monday, which is the day this cron runs. */
const MONDAY_SHIFT_MS = 3 * 24 * 3_600_000;
/** Claims are housekeeping; a month is long enough to read a history and short
 * enough that the table stays a handful of rows. */
const CLAIM_RETENTION_DAYS = 28;

/** The Monday-aligned week `now` falls in. */
export function verifyWeekStart(now: Date): Date {
  return new Date(
    Math.floor((now.getTime() + MONDAY_SHIFT_MS) / WEEK_MS) * WEEK_MS - MONDAY_SHIFT_MS,
  );
}

/**
 * Claim the right to sweep this week; true exactly once, for whoever gets there
 * first. Same mechanism and same reasoning as the provider-incident claim: a
 * family-independent ops event, made atomic by rate_limits' unique index, so a
 * Vercel retry or a manual re-trigger cannot double-spend on fetches and model
 * calls or send a second founder email.
 */
export async function claimVerifySweepWeek(database: Database, now: Date): Promise<boolean> {
  const windowStart = verifyWeekStart(now);

  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, REGISTRATION_VERIFY_ROUTE),
        lt(schema.rateLimits.windowStart, new Date(now.getTime() - CLAIM_RETENTION_DAYS * 86_400_000)),
      ),
    );

  const claimed = await database
    .insert(schema.rateLimits)
    .values({ identifier: 'weekly-sweep', route: REGISTRATION_VERIFY_ROUTE, windowStart, count: 1 })
    .onConflictDoNothing({
      target: [schema.rateLimits.identifier, schema.rateLimits.route, schema.rateLimits.windowStart],
    })
    .returning({ id: schema.rateLimits.id });

  return claimed.length > 0;
}

/** The four numbers one finished run leaves behind. */
export interface VerifyRunCounts {
  checked: number;
  confirmed: number;
  discrepancies: number;
  unverified: number;
}

export type RecordVerifyRun = (
  database: Database,
  weekStart: Date,
  counts: VerifyRunCounts,
) => Promise<void>;

/**
 * Persist what this run found (migration 0089).
 *
 * A SECOND ROW, not a second write to the claim: the claim is taken BEFORE the work and
 * answers "who owns this week", while this is only knowable after and answers "what did
 * the run find". The unique index on week_start means the claim's exactly-once guarantee
 * is restated by the database — a duplicate raises rather than quietly overwriting a
 * week's outcomes, and the caller logs it.
 */
export const recordVerifyRun: RecordVerifyRun = async (database, weekStart, counts) => {
  await database.insert(schema.registrationVerifyRuns).values({ weekStart, ...counts });
};

// ── the digest ───────────────────────────────────────────────────────────────

const FIELD_LABEL: Record<VerifyField, string> = {
  previewAt: 'preview_at',
  residentOpenAt: 'resident_open_at',
  openAt: 'open_at',
};

/** `2026-08-11 06:30` in Toronto local time — the wall clock a parent would set
 * an alarm for, which is the only reading of these instants that means anything. */
function localStamp(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REGISTRATION_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function rowHeading(row: RowResult): string {
  return `${row.municipality} · ${row.programDomain} · ${row.cycleLabel}`;
}

/**
 * The founder-digest body. Pure, so the wording is unit-tested directly.
 *
 * CONFIRMED ROWS ARE NOT LISTED. Confirmation is what silence means here; a
 * weekly wall of "still fine" is how a founder learns to skim past the one line
 * that mattered. The count is kept so "we checked, and they were fine" stays
 * legible.
 */
export function formatRegistrationVerifyDigest(
  summary: Pick<
    RegistrationVerifySummary,
    'checked' | 'confirmed' | 'discrepancies' | 'unverified' | 'rows' | 'discoveries'
  >,
  now: Date,
): string {
  const lines: string[] = [
    `Hale · registration re-verify · ${localStamp(now).slice(0, 10)}`,
    '',
    `${summary.checked} upcoming windows checked — ${summary.confirmed} confirmed, ` +
      `${summary.discrepancies} discrepancies, ${summary.unverified} could not be verified.`,
  ];

  const discrepancies = summary.rows.filter((r) => r.outcome.kind === 'discrepancy');
  if (discrepancies.length > 0) {
    lines.push('', 'DISCREPANCY — the page no longer says what we store');
    for (const row of discrepancies) {
      if (row.outcome.kind !== 'discrepancy') continue;
      lines.push(`  ${rowHeading(row)}`);
      for (const diff of row.outcome.diffs) {
        const stored = diff.stored === null ? '(nothing stored)' : localStamp(diff.stored);
        lines.push(`    ${FIELD_LABEL[diff.field]}: we store ${stored} · page says ${localStamp(diff.published)}`);
      }
      if (row.outcome.evidence) {
        lines.push(`    the page's words: "${row.outcome.evidence}"`);
      }
      lines.push(`    ${row.sourceUrl}`);
    }
    lines.push(
      '',
      '  Nothing was changed. These rows keep their old dates and their old verified_at',
      '  until a human reads the page and updates the seed.',
    );
  }

  const unverified = summary.rows.filter((r) => r.outcome.kind === 'unverified');
  if (unverified.length > 0) {
    lines.push('', 'Could not verify — needs a human look');
    for (const row of unverified) {
      if (row.outcome.kind !== 'unverified') continue;
      const detail = row.detail ? ` (${row.detail})` : '';
      lines.push(`  ${rowHeading(row)} — ${row.outcome.reason}${detail}`);
      lines.push(`    ${row.sourceUrl}`);
    }
  }

  const found = summary.discoveries.filter((d) => d.published);
  appendDiscoveries(
    lines,
    'ESCALATION — published 7 days ago and still not in the dataset',
    found.filter((d) => d.escalated),
  );
  appendDiscoveries(
    lines,
    'new window published — add?',
    found.filter((d) => !d.escalated),
  );
  if (found.length > 0) {
    lines.push(
      '',
      '  Nothing was added. The dataset stays hand-verified — read the page, then',
      '  add the row to registration-windows-data.ts.',
    );
  }

  return lines.join('\n');
}

function appendDiscoveries(lines: string[], heading: string, discoveries: readonly DiscoveryResult[]): void {
  if (discoveries.length === 0) return;
  lines.push('', heading);
  for (const discovery of discoveries) {
    lines.push(
      `  ${discovery.target.municipality} · ${discovery.target.programDomain} · ${discovery.target.cycleLabel}`,
    );
    const reading = discovery.reading;
    if (reading) {
      for (const [label, value] of [
        ['preview', reading.preview],
        ['resident open', reading.residentOpen],
        ['general open', reading.generalOpen],
      ] as const) {
        if (value) {
          lines.push(`    ${label}: ${value.date}${value.time ? ` ${value.time}` : ' (no time published)'}`);
        }
      }
      if (reading.evidence) {
        lines.push(`    the page's words: "${reading.evidence}"`);
      }
    }
    if (discovery.sourceUrl) lines.push(`    ${discovery.sourceUrl}`);
  }
}

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

/** Mirrors the loop-health / provider-alert sender exactly: same aloha@ identity,
 * same injectable client, same best-effort contract. */
export function createRegistrationDigestSender(client?: Resend): ProviderAlertSender {
  return {
    async send(subject, text) {
      const to = founderAddress();
      if (!to) {
        return false;
      }
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        return false;
      }
      const transport = createResendTransport({ apiKey, client });
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { error } = await transport.send({ from, to, subject, text });
      return !error;
    },
  };
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface RegistrationVerifyDeps {
  /** Null when there is no key configured; the sweep then does nothing rather
   * than fetching pages it cannot read. */
  client: AgentClient | null;
  fetchPage: FetchPage;
  extract(cycle: CycleIdentity, pageText: string): Promise<ExtractedWindow>;
  loadWindows(database: Database, now: Date, limit: number): Promise<StoredWindow[]>;
  markVerified(database: Database, windowId: string, now: Date): Promise<void>;
  claimWeek(database: Database, now: Date): Promise<boolean>;
  /** Writes the run's own tally. Non-nullable (rule #11): a sweep whose outcomes go
   * nowhere is exactly the state this ledger exists to end, so its absence is a failed
   * write that says so, never a missing dependency. */
  recordRun: RecordVerifyRun;
  /** Writes each discovery reading. Non-nullable (rule #11): a sweep that found
   * a date and kept it only in an email is the gap this table exists to close. */
  recordDiscoveries: (database: Database, readings: readonly DiscoveryReadingInsert[]) => Promise<void>;
  /** Published readings old enough to escalate. A failure here is logged by the
   * caller and treated as no history — an escalation that did not happen,
   * named, rather than a sweep that aborts. */
  loadDiscoveryHistory: (database: Database, now: Date) => Promise<PriorPublishedDiscovery[]>;
  sender: ProviderAlertSender;
  preflight: typeof providerPreflight;
  discoveryTargets: readonly DiscoveryTarget[];
}

export function defaultRegistrationVerifyDeps(
  client: AgentClient | null,
): RegistrationVerifyDeps {
  return {
    client,
    fetchPage: createFetchPage(),
    extract: (cycle, pageText) => {
      if (!client) throw new Error('registration verify: no model client');
      return extractPublishedWindow(cycle, pageText, { client });
    },
    loadWindows: loadUpcomingWindows,
    markVerified: markWindowVerified,
    claimWeek: claimVerifySweepWeek,
    recordRun: recordVerifyRun,
    recordDiscoveries: recordDiscoveryReadings,
    loadDiscoveryHistory: loadPriorPublishedDiscoveries,
    sender: createRegistrationDigestSender(),
    preflight: providerPreflight,
    discoveryTargets: DISCOVERY_TARGETS,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch each distinct page ONCE per run, failures included. Four Burlington rows
 * share one table; re-reading it four times would spend four times as long and
 * lean four times as hard on a public body's server for the same bytes. */
export function pageCache(fetchPage: FetchPage) {
  const cache = new Map<string, Promise<string>>();
  return (url: string): Promise<string> => {
    const existing = cache.get(url);
    if (existing) return existing;
    const pending = fetchPage(url);
    cache.set(url, pending);
    return pending;
  };
}

async function verifyRow(
  row: StoredWindow,
  getPage: (url: string) => Promise<string>,
  deps: RegistrationVerifyDeps,
): Promise<RowResult> {
  const base = {
    windowId: row.id,
    municipality: row.municipality,
    programDomain: row.programDomain,
    cycleLabel: row.cycleLabel,
    sourceUrl: row.sourceUrl,
  };

  let pageText: string;
  try {
    pageText = await getPage(row.sourceUrl);
  } catch (err) {
    console.error({ err, windowId: row.id, url: row.sourceUrl }, 'registration verify: fetch failed');
    return { ...base, outcome: { kind: 'unverified', reason: 'fetch_failed' }, detail: errorText(err) };
  }

  let reading: ExtractedWindow;
  try {
    reading = await deps.extract(row, pageText);
  } catch (err) {
    console.error({ err, windowId: row.id }, 'registration verify: extraction failed');
    return {
      ...base,
      outcome: { kind: 'unverified', reason: 'extract_failed' },
      detail: errorText(err),
    };
  }

  const failure = corroborationFailure(pageText, reading);
  if (failure !== null) {
    console.error(
      { windowId: row.id, evidence: reading.evidence },
      'registration verify: reading not corroborated by the page — DISCARDED',
    );
    return { ...base, outcome: { kind: 'unverified', reason: failure } };
  }

  // The dataset's own marker has the last word (VIL-347): a field this row never read off
  // its own source is not evidence, however neatly the page's dates line up with it.
  return {
    ...base,
    outcome: withoutInferredEvidence(compareWindow(row, reading), inferredFieldsFor(row)),
  };
}

interface DiscoveryPass {
  result: DiscoveryResult;
  readings: DiscoveryReadingInsert[];
}

/**
 * Read every URL on the target. A find on any of them publishes the target;
 * each URL still gets its own reading, including the page that said nothing,
 * so a later look can tell which page had the date.
 */
async function discoverTarget(
  target: DiscoveryTarget,
  getPage: (url: string) => Promise<string>,
  deps: RegistrationVerifyDeps,
  now: Date,
): Promise<DiscoveryPass> {
  const readings: DiscoveryReadingInsert[] = [];
  let publishedReading: ExtractedWindow | null = null;
  let publishedUrl: string | null = null;
  let detail: string | undefined;

  for (const url of target.sourceUrls) {
    let pageText: string;
    try {
      pageText = await getPage(url);
    } catch (err) {
      console.error({ err, url }, 'registration verify: discovery fetch failed');
      detail = errorText(err);
      readings.push({
        municipality: target.municipality,
        programDomain: target.programDomain,
        cycleLabel: target.cycleLabel,
        sourceUrl: url,
        published: false,
        reading: null,
        pageHash: null,
        readAt: now,
      });
      continue;
    }

    const pageHash = discoveryPageHash(pageText);
    try {
      const reading = await deps.extract(target, pageText);
      const published = isTrustworthyFind(pageText, reading);
      readings.push({
        municipality: target.municipality,
        programDomain: target.programDomain,
        cycleLabel: target.cycleLabel,
        sourceUrl: url,
        published,
        reading,
        pageHash,
        readAt: now,
      });
      if (published && publishedReading === null) {
        publishedReading = reading;
        publishedUrl = url;
      }
    } catch (err) {
      console.error({ err, url }, 'registration verify: discovery extract failed');
      detail = errorText(err);
      readings.push({
        municipality: target.municipality,
        programDomain: target.programDomain,
        cycleLabel: target.cycleLabel,
        sourceUrl: url,
        published: false,
        reading: null,
        pageHash,
        readAt: now,
      });
    }
  }

  return {
    result: {
      target,
      published: publishedReading !== null,
      reading: publishedReading,
      sourceUrl: publishedUrl,
      detail,
      escalated: false,
    },
    readings,
  };
}

function targetWasPublishedEarlier(
  target: DiscoveryTarget,
  history: readonly PriorPublishedDiscovery[],
): boolean {
  return history.some(
    (row) =>
      row.municipality === target.municipality &&
      row.programDomain === target.programDomain &&
      row.cycleLabel === target.cycleLabel,
  );
}

/**
 * The weekly cron entry point.
 *
 * Order matters. The provider pre-flight runs BEFORE the week is claimed, so a
 * window cancelled by an empty balance can still be retried later the same week —
 * claiming first would burn the week on a run that did nothing.
 */
export async function runRegistrationVerifySweep(
  database: Database,
  deps: RegistrationVerifyDeps,
  now: Date = new Date(),
): Promise<RegistrationVerifySummary> {
  const empty: RegistrationVerifySummary = {
    checked: 0,
    confirmed: 0,
    discrepancies: 0,
    unverified: 0,
    rows: [],
    discoveries: [],
  };

  // No key configured: reading a page is the whole job, so there is nothing to do
  // and no reason to fetch anything. Degrades to a clean no-op rather than a run
  // that fails once per row and emails the founder about itself.
  if (!deps.client) {
    return { ...empty, skipped: 'no_model_client' };
  }

  const preflight = await deps.preflight(database, 'registration_verify', deps.client, now);
  if (!preflight.proceed) {
    return { ...empty, aborted: preflight.abort };
  }

  if (!(await deps.claimWeek(database, now))) {
    return { ...empty, skipped: 'already_ran_this_week' };
  }

  const windows = await deps.loadWindows(database, now, MAX_WINDOWS_PER_RUN);
  const getPage = pageCache(deps.fetchPage);

  const rows: RowResult[] = [];
  for (const window of windows) {
    rows.push(await verifyRow(window, getPage, deps));
  }

  // The write happens after the read, and only for confirmations. A row whose
  // outcome is anything else keeps its old verified_at — that staleness is the
  // signal, and erasing it would hide the very thing this sweep exists to find.
  let confirmed = 0;
  for (const row of rows) {
    if (row.outcome.kind !== 'confirmed') continue;
    try {
      await deps.markVerified(database, row.windowId, now);
      confirmed += 1;
    } catch (err) {
      console.error({ err, windowId: row.windowId }, 'registration verify: verified_at bump failed');
    }
  }

  let history: PriorPublishedDiscovery[] = [];
  try {
    history = await deps.loadDiscoveryHistory(database, now);
  } catch (err) {
    // Named, not swallowed: this run can still record what it saw, and it will
    // not escalate on history it failed to read.
    console.error({ err }, 'registration verify: discovery history unavailable');
  }

  const discoveries: DiscoveryResult[] = [];
  const readings: DiscoveryReadingInsert[] = [];
  for (const target of deps.discoveryTargets) {
    const pass = await discoverTarget(target, getPage, deps, now);
    pass.result.escalated = pass.result.published && targetWasPublishedEarlier(target, history);
    discoveries.push(pass.result);
    readings.push(...pass.readings);
  }

  try {
    await deps.recordDiscoveries(database, readings);
  } catch (err) {
    console.error({ err }, 'registration verify: discovery readings not recorded');
  }

  const summary: RegistrationVerifySummary = {
    checked: rows.length,
    confirmed,
    discrepancies: rows.filter((r) => r.outcome.kind === 'discrepancy').length,
    unverified: rows.filter((r) => r.outcome.kind === 'unverified').length,
    rows,
    discoveries,
  };

  // The tally, for the founder scorecard to grade the radar on. Best-effort by the same
  // contract as the digest below: this is telemetry about a sweep that has already
  // happened, and losing the row must not turn a completed run into a failed one. Logged
  // rather than swallowed — a week graded "recorded no outcomes" is the visible cost.
  try {
    await deps.recordRun(database, verifyWeekStart(now), {
      checked: summary.checked,
      confirmed: summary.confirmed,
      discrepancies: summary.discrepancies,
      unverified: summary.unverified,
    });
  } catch (err) {
    console.error({ err }, 'registration verify: outcomes not recorded');
  }

  const actionable =
    summary.discrepancies > 0 || summary.unverified > 0 || discoveries.some((d) => d.published);
  if (actionable) {
    const subject =
      summary.discrepancies > 0
        ? `Hale · registration re-verify: ${summary.discrepancies} discrepancies`
        : discoveries.some((d) => d.escalated)
          ? 'Hale · registration re-verify: discovery still open after 7 days'
          : 'Hale · registration re-verify: needs a look';
    try {
      const delivered = await deps.sender.send(
        subject,
        formatRegistrationVerifyDigest(summary, now),
      );
      if (!delivered) {
        // Refused before it left (no founder address / no Resend key) rather than
        // thrown. Silent here would mean a sweep that found discrepancies and told
        // nobody, reported as a clean run (VIL-267).
        console.warn('registration verify: digest not delivered (alert sender unconfigured)');
      }
    } catch (err) {
      // Best-effort by contract, exactly like the provider alert: a failed email
      // must not turn a completed sweep into a failed run.
      console.error({ err }, 'registration verify: digest send failed');
    }
  }

  return summary;
}
