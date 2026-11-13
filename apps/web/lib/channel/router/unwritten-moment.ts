import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { type Moment, momentUnwritten } from '~/lib/channel/off-domain/moment-reply';
import type { CrisisKind } from '~/lib/channel/voice/crisis-check';
import { logCrisisUnanswered } from '~/lib/channel/voice/said-line';
import { failurePageCrisisPager } from '~/lib/monitoring/failure-page';
import type { ChannelRouterDeps } from './route';

/** The crisis a moment is, or null for a moment that is not one. */
function momentCrisisKind(moment: Moment): CrisisKind | null {
  if (moment === 'mental_crisis') return 'mental';
  if (moment === 'emergency') return 'emergency';
  return null;
}

/**
 * A moment the off-domain lane could not write a reply for. A crisis pages #ops now, from
 * whichever read of the text found it: GATE 4 (route.ts) and the side turn in its place
 * (side-turn.ts) both call this, so a crisis nobody could answer never waits for the
 * text's next turn to reach a human. The page is one per inbound however often it is
 * read (failure-page.ts).
 */
export async function pageUnwrittenCrisis(
  deps: Pick<ChannelRouterDeps, 'database' | 'crisisPager'>,
  job: ChannelMessageReceivedJob,
  verdict: { moment: Moment; reason: string },
  where: string,
): Promise<void> {
  const crisis = momentCrisisKind(verdict.moment);
  if (crisis === null) return;
  await logCrisisUnanswered(deps.crisisPager ?? failurePageCrisisPager(deps.database), {
    kind: crisis,
    where,
    ...momentUnwritten(verdict.reason),
    inboundId: job.provider_message_id,
    familyId: job.family_id,
    parentUserId: job.parent_user_id,
  });
}
