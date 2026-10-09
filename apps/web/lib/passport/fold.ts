import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
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
export async function foldPassportIntoOutbound(args: {
  database: Database;
  familyId: string;
  parentUserId: string;
  inboundBody: string;
  outboundBody: string;
  now: Date;
  client?: AgentClient | null;
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
