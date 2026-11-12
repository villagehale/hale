import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import { TEXTABLE_ROLES } from '~/lib/channel/family-recipients';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import { withoutTeenTitles } from '~/lib/channel/linq/kid-event';
import {
  type OutboundGatePorts,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { type CandidateDraft, queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { boundedLine } from '~/lib/channel/proactive/tools';
import { teenChildIds } from '~/lib/channel/role-scope';
import { workstreamsEnabled } from '~/lib/memory/workstreams';
import { NEXT_DAY_CHECKBACK_TEMPLATE_KEY, nextDayCheckbackDedupeKey } from './claim';
import { checkbackTiming } from './decide';
import { nextDayCheckbackEnabled } from './flag';

/**
 * VIL-681 · next-day pickup. A parent started something with Hale and went quiet: the
 * next day Hale may check back once. The SENDER IS the proactive decider: a due ask is
 * queued as a `next_day_checkback` candidate, and the decider decides whether and when,
 * and its writer words it, inside the outbound gate and quiet hours.
 *
 * The only signal is a VIL-419 workstream the extraction model labelled
 * `waiting_on_parent` at the end of a reply turn. Nothing here reads the parent's words.
 * Any text the asker sent after that turn means they came back, and that turn owns the
 * ask. A model-set `check_back_at` belongs to the VIL-419 follow-up, not here.
 *
 * At most one per ask: the candidate's (family, dedupe key) is unique, so an ask queues
 * once, ever, whatever the decider does with it.
 */

/**
 * An infra bound, not a send rule: the waiting rows one run reads, oldest first. Rows
 * past it wait for the next hourly run.
 */
export const ROWS_PER_RUN = 200;
/** An ask's day closes at most a little over two days after it: older rows are past it. */
const LOOKBACK_MS = 3 * 86_400_000;

export interface NextDayCheckbackPayload {
  workstreamId: string;
  anchorAt: string;
  subjectChildId: string | null;
}

export interface NextDayCheckbackResult {
  /** The lane did not read. Null when it ran. */
  skipped: 'flag_off' | 'workstreams_off' | null;
  examined: number;
  f14Dark: number;
  teenScoped: number;
  /** The row was not written from an inbound text of a parent who still holds a seat. */
  noAsker: number;
  zoneUnknown: number;
  tooSoon: number;
  pastDay: number;
  /** The asker texted after the ask: that turn owns it. */
  parentReturned: number;
  /** The outbound gate refused the asker (STOP, consent, quiet hours). Nothing queued. */
  held: number;
  queued: number;
  duplicate: number;
}

function emptyResult(skipped: NextDayCheckbackResult['skipped']): NextDayCheckbackResult {
  return {
    skipped,
    examined: 0,
    f14Dark: 0,
    teenScoped: 0,
    noAsker: 0,
    zoneUnknown: 0,
    tooSoon: 0,
    pastDay: 0,
    parentReturned: 0,
    held: 0,
    queued: 0,
    duplicate: 0,
  };
}

export interface NextDayCheckbackDeps {
  buildGate(database: Database): OutboundGatePorts;
  queueCandidate(database: Database, draft: CandidateDraft): Promise<'queued' | 'duplicate'>;
  f14For(familyId: string): boolean;
}

export function defaultNextDayCheckbackDeps(): NextDayCheckbackDeps {
  return {
    buildGate: buildOutboundGatePorts,
    queueCandidate: queueCheckInForDecider,
    f14For: f14EnabledFor,
  };
}

/**
 * The candidate the decider reads. `why` is names-free, for the decider; `what` is the
 * thread's own title and next step, read by the writer only.
 */
export function nextDayCheckbackDraft(input: {
  familyId: string;
  parentUserId: string;
  workstreamId: string;
  title: string;
  nextStep: string | null;
  anchorAt: Date;
  closesAt: Date;
  subjectChildId: string | null;
}): CandidateDraft {
  const payload: NextDayCheckbackPayload = {
    workstreamId: input.workstreamId,
    anchorAt: input.anchorAt.toISOString(),
    subjectChildId: input.subjectChildId,
  };
  return {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    kind: 'next_day_checkback',
    category: 'followup',
    templateKey: NEXT_DAY_CHECKBACK_TEMPLATE_KEY,
    what: boundedLine(input.nextStep ? `${input.title}: ${input.nextStep}` : input.title),
    why: `next_day_checkback asked=${payload.anchorAt}`,
    sourceUrl: null,
    worthlessAfter: input.closesAt,
    parentRequested: false,
    dedupeKey: nextDayCheckbackDedupeKey(input.workstreamId),
    payload: { nextDayCheckback: payload },
  };
}

interface FamilyFacts {
  zone: string | null;
  teenIds: Set<string>;
  childNames: string[];
  teenNames: string[];
}

async function familyFacts(database: Database, familyId: string, now: Date): Promise<FamilyFacts> {
  const children = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const teenIds = teenChildIds(children, now);
  return {
    zone: await knownHouseholdTimezone(database, familyId),
    teenIds,
    childNames: children.map((child) => child.name),
    teenNames: children.filter((child) => teenIds.has(child.id)).map((child) => child.name),
  };
}

/** A 13+ child's thread, by id or by a title or step the age gate credits to a teen. */
function teenScoped(
  row: { title: string; nextStep: string | null; childIds: readonly string[] },
  facts: FamilyFacts,
): boolean {
  if (row.childIds.some((id) => facts.teenIds.has(id))) return true;
  const lines = [row.title, row.nextStep].filter((line): line is string => line !== null);
  const kept = withoutTeenTitles(
    lines.map((title) => ({ title, kidRelated: true })),
    facts.childNames,
    facts.teenNames,
  );
  return kept.some((line) => line.title === null);
}

/**
 * The parent whose inbound text the row was last written from, while they still hold a
 * parent seat in this family. A row closed by expiry, or written from anything but a
 * parent's own text, has no asker.
 */
export async function resolveAsker(
  database: Database,
  row: { familyId: string; updatedFrom: string },
): Promise<string | null> {
  const [asker] = await database
    .select({ parentUserId: schema.channelMessages.parentUserId })
    .from(schema.channelMessages)
    .innerJoin(
      schema.familyMembers,
      and(
        eq(schema.familyMembers.familyId, schema.channelMessages.familyId),
        eq(schema.familyMembers.userId, schema.channelMessages.parentUserId),
      ),
    )
    .where(
      and(
        sql`${schema.channelMessages.id}::text = ${row.updatedFrom}`,
        eq(schema.channelMessages.familyId, row.familyId),
        eq(schema.channelMessages.direction, 'in'),
        inArray(schema.familyMembers.role, [...TEXTABLE_ROLES]),
      ),
    )
    .limit(1);
  return asker?.parentUserId ?? null;
}

/** Any text from the asker in this family after the ask, other than the ask itself. */
export async function askerReturned(
  database: Database,
  input: { familyId: string; parentUserId: string; anchor: Date; updatedFrom: string },
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'in'),
        gt(schema.channelMessages.createdAt, input.anchor),
        sql`${schema.channelMessages.id}::text <> ${input.updatedFrom}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function runNextDayCheckbackSweep(
  database: Database,
  now: Date = new Date(),
  deps: NextDayCheckbackDeps = defaultNextDayCheckbackDeps(),
): Promise<NextDayCheckbackResult> {
  if (!nextDayCheckbackEnabled()) {
    console.info({ env: 'NEXT_DAY_CHECKBACK_ENABLED' }, 'next-day check-back: dark, nothing read');
    return emptyResult('flag_off');
  }
  if (!workstreamsEnabled()) {
    console.info(
      { env: 'WORKSTREAMS_ENABLED' },
      'next-day check-back: no workstreams, nothing read',
    );
    return emptyResult('workstreams_off');
  }

  const result = emptyResult(null);
  const ws = schema.familyWorkstreams;
  const rows = await database
    .select({
      id: ws.id,
      familyId: ws.familyId,
      title: ws.title,
      nextStep: ws.nextStep,
      childIds: ws.childIds,
      updatedAt: ws.updatedAt,
      updatedFrom: ws.updatedFrom,
    })
    .from(ws)
    .where(
      and(
        eq(ws.status, 'waiting_on_parent'),
        isNull(ws.closedAt),
        isNull(ws.checkBackAt),
        isNull(ws.lastFollowedUpAt),
        gt(ws.expiresAt, now),
        gte(ws.updatedAt, new Date(now.getTime() - LOOKBACK_MS)),
      ),
    )
    .orderBy(asc(ws.updatedAt), asc(ws.id))
    .limit(ROWS_PER_RUN);

  const facts = new Map<string, FamilyFacts>();
  const gate = deps.buildGate(database);
  for (const row of rows) {
    result.examined += 1;
    if (!deps.f14For(row.familyId)) {
      result.f14Dark += 1;
      continue;
    }
    let family = facts.get(row.familyId);
    if (!family) {
      family = await familyFacts(database, row.familyId, now);
      facts.set(row.familyId, family);
    }
    if (teenScoped(row, family)) {
      result.teenScoped += 1;
      continue;
    }
    const parentUserId = await resolveAsker(database, row);
    if (parentUserId === null) {
      result.noAsker += 1;
      continue;
    }
    if (family.zone === null) {
      result.zoneUnknown += 1;
      continue;
    }
    const timing = checkbackTiming({ anchor: row.updatedAt, timeZone: family.zone, now });
    if (!timing.due) {
      if (timing.reason === 'too_soon') result.tooSoon += 1;
      else result.pastDay += 1;
      continue;
    }
    if (
      await askerReturned(database, {
        familyId: row.familyId,
        parentUserId,
        anchor: row.updatedAt,
        updatedFrom: row.updatedFrom,
      })
    ) {
      result.parentReturned += 1;
      continue;
    }
    // Before the queue, so a parent the gate refuses never uses up the one chance.
    const verdict = await assertProactiveSendAllowed(
      { familyId: row.familyId, parentUserId, kind: 'next_day_checkback', now },
      gate,
    );
    if (!verdict.allowed) {
      result.held += 1;
      continue;
    }
    const subjectChildId = row.childIds.length === 1 ? (row.childIds[0] as string) : null;
    const queued = await deps.queueCandidate(
      database,
      nextDayCheckbackDraft({
        familyId: row.familyId,
        parentUserId,
        workstreamId: row.id,
        title: row.title,
        nextStep: row.nextStep,
        anchorAt: row.updatedAt,
        closesAt: timing.closesAt,
        subjectChildId,
      }),
    );
    if (queued === 'duplicate') {
      result.duplicate += 1;
      continue;
    }
    result.queued += 1;
    await database.insert(schema.auditLog).values({
      familyId: row.familyId,
      actor: 'system',
      actionTaken: 'proactive_cadence_queued',
      targetTable: 'family_workstreams',
      targetId: row.id,
      after: { kind: 'next_day_checkback' },
    });
  }
  if (result.queued > 0) {
    console.info({ queued: result.queued }, 'next-day check-back: queued for the decider');
  }
  return result;
}
