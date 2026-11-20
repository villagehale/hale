import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import {
  type ClaimEnforcer,
  defaultClaimEnforcer,
  refusedResolutions,
} from '~/lib/channel/reconcile/claim-enforce';
import { CLAIM_READ_MAX_BUDGET_MS } from '~/lib/channel/reconcile/claim-reader';
import type { ReconcileView } from '~/lib/channel/reconcile/reconcile';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { composePassportLine, interpretPassportReply } from './copy';
import { interestPassportEnabled } from './flag';
import {
  type SourceType,
  appendPassportLine,
  nextStepOffer,
  progressLabel,
  sessionEnding,
  sourceLabel,
} from './signals';
import {
  applyParentIntent,
  latestUnasked,
  listFamilyChildren,
  markAsked,
  offeredThisSeason,
  recordNextStep,
} from './store';

/**
 * One passport sentence on a text that is already being sent. Flag off returns
 * the original body before any read. A missing model, or a line that fails the
 * guards, leaves the body as it was (`copy_unavailable` — nothing canned).
 */

/** Rows the passport door does not write; a mint on this line is dropped. */
const PASSPORT_DOOR_VIEW: ReconcileView = {
  openKinds: new Set(),
  pendingKinds: new Set(),
  registrationLaddered: false,
  mintableWindow: null,
  scheduledTitles: [],
  statedBookings: [],
};

/**
 * VIL-581 · the passport line is folded on AFTER the coach's claim read, so this
 * door is the only read that sees it. A failed or unbacked line is dropped, by name;
 * the reply that was already gated still goes. Off (or a family the flag does not
 * enforce) leaves the line. A throw reaches the fold's own catch, which logs it and
 * sends the body without the line.
 */
export async function passportDoorAllowsLine(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date; line: string },
  enforcer: ClaimEnforcer = defaultClaimEnforcer(),
): Promise<boolean> {
  if (!enforcer.enforces(input.familyId)) return true;
  const read = await enforcer.read(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
    body: input.line,
    view: PASSPORT_DOOR_VIEW,
    signal: new AbortController().signal,
    budgetMs: CLAIM_READ_MAX_BUDGET_MS,
  });
  // The read's own failure is already captured on the claim_read lane.
  if (read.status === 'failed') return false;
  const refused = refusedResolutions(read.verdict).map((r) => r.reason);
  if (refused.length > 0 || read.mints.length > 0) {
    console.error(
      { event: 'passport_line_refused', reasons: refused, mints: read.mints.length },
      'passport: the line claimed a row that does not back it - dropped',
    );
    return false;
  }
  return true;
}

export async function foldPassportIntoOutbound(args: {
  database: Database;
  familyId: string;
  parentUserId: string;
  inboundBody: string;
  outboundBody: string;
  now: Date;
  client?: AgentClient | null;
  claimEnforcer?: ClaimEnforcer;
}): Promise<string> {
  if (!interestPassportEnabled()) return args.outboundBody;
  if (!args.outboundBody.trim()) return args.outboundBody;
  try {
    const client = await resolveReplyClient(args.client);
    const children = await listFamilyChildren(args.database, args.familyId, args.now);
    const intent = await interpretPassportReply(client, args.inboundBody);
    const applied = await applyParentIntent(args.database, {
      familyId: args.familyId,
      actor: args.parentUserId,
      intent,
      children,
      now: args.now,
    });
    const unasked = applied.applied ? null : await latestUnasked(args.database, args.familyId);
    if (!applied.applied && !unasked) return args.outboundBody;

    const child = children.find((item) => item.id === unasked?.childId);
    const next =
      unasked?.childId && !applied.applied
        ? nextStepOffer({
            alreadyOffered: await offeredThisSeason(
              args.database,
              unasked.childId,
              unasked.seasonKey,
            ),
            sessionEnding: sessionEnding({
              completed: unasked.completedAt !== null,
              sessionEnd: unasked.sessionEnd,
              weeksTotal: unasked.weeksTotal,
              weeksElapsed: unasked.weeksElapsed,
              now: args.now,
            }),
            forbiddenActivityKeys: [],
          })
        : null;
    const line = await composePassportLine(client, {
      job: applied.acknowledgment ? 'acknowledge' : 'confirm',
      acknowledgment: applied.acknowledgment,
      language: 'en',
      childName: child?.name ?? null,
      activity: unasked?.activity ?? null,
      seasonLabel: unasked
        ? progressLabel({
            kind: unasked.kind === 'outing' ? 'outing' : 'activity',
            seasonLabel: unasked.seasonLabel,
            weeksTotal: unasked.weeksTotal,
            weeksElapsed: unasked.weeksElapsed,
            sessionStart: unasked.sessionStart,
            completed: unasked.completedAt !== null,
            now: args.now,
          })
        : null,
      sourceLabel: unasked
        ? sourceLabel({
            sourceType: (['gmail', 'calendar', 'parent', 'group_share'] as const).includes(
              unasked.sourceType as SourceType,
            )
              ? (unasked.sourceType as SourceType)
              : 'gmail',
            viewerIsOwner: unasked.sourceOwnerUserId === args.parentUserId,
            ownerFirstName: null,
            sharerFirstName: null,
            toldOn: null,
          })
        : null,
      nextStep: next,
    });
    const appended = appendPassportLine(args.outboundBody, line.ok ? line.text : null, true);
    if (!appended.included) return args.outboundBody;
    if (line.ok) {
      const allowed = await passportDoorAllowsLine(
        args.database,
        {
          familyId: args.familyId,
          parentUserId: args.parentUserId,
          now: args.now,
          line: line.text,
        },
        args.claimEnforcer ?? defaultClaimEnforcer(),
      );
      if (!allowed) return args.outboundBody;
    }
    if (unasked && !applied.applied) {
      await markAsked(args.database, {
        familyId: args.familyId,
        stampId: unasked.id,
        now: args.now,
      });
    }
    if (line.ok && line.suggestedActivity && unasked?.childId && next) {
      await recordNextStep(args.database, {
        familyId: args.familyId,
        childId: unasked.childId,
        seasonKey: unasked.seasonKey,
        now: args.now,
      });
    }
    return appended.body;
  } catch (err) {
    console.error(
      {
        familyId: args.familyId,
        err: err instanceof Error ? err.constructor.name : 'unknown',
      },
      'passport: outbound fold skipped',
    );
    return args.outboundBody;
  }
}
