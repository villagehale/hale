import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { approveDraftedAction } from '~/lib/actions/approve';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { DeterministicHandler } from '~/lib/channel/router/route';
import { SPOT_PORTAL_HOSTS, sanitizeSpotUrl } from '~/lib/channel/spots/url';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { pipelineClient } from '~/lib/pipeline/client';
import { getQueue } from '~/lib/queue';
import { registrationPageUrl } from '../page';
import {
  type RegistrationReader,
  createRegistrationReader,
  registrationDate,
  registrationHasOpened,
  registrationWhen,
  unclassifiedRegistrationDate,
} from '../read';
import { type RegistrationRequestReader, createRegistrationRequestReader } from '../request-read';
import { loadPreparingSequence } from './prepare-reply';
import {
  claimRegistrationSend,
  refreshRegistrationWatch,
  releaseRegistrationSend,
} from './refresh';
import { claimRegistrationWatch } from './watch-storage';

export function registrationLinkIn(body: string): string | null {
  const urls = body.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  if (urls.length !== 1) return null;
  return urls[0]!.replace(/[.,;)]+$/, '');
}

/** Creates only a watch + reviewed approval. A paste is never subscription consent. */
export function registrationLinkHandler(
  ports: {
    readRequest: RegistrationRequestReader;
    reader(): RegistrationReader;
    draft(
      database: Database,
      input: { familyId: string; parentUserId: string; sourceUrl: string; summary: string },
    ): Promise<string>;
    approve(
      database: Database,
      input: { familyId: string; actionId: string; approvedBy: string },
    ): Promise<void>;
  } = {
    readRequest: createRegistrationRequestReader(pipelineClient),
    reader: createRegistrationReader,
    draft: async (database, input) =>
      (
        await draftInlineAction(
          {
            familyId: input.familyId,
            actor: input.parentUserId,
            intentKind: 'registration_shortlist',
            childId: null,
            sourceAnswer: input.summary,
            title: 'Registration reminder plan',
            sourceUrl: input.sourceUrl,
            origin: 'ask_hale',
            contentProvenance: 'hale_authored',
          },
          database,
          pipelineClient(),
        )
      ).actionId,
    approve: async (database, input) => {
      const result = await approveDraftedAction(database, await getQueue(), input);
      if (result.status !== 202) throw new Error('registration reminder approval refused');
    },
  },
): DeterministicHandler {
  return {
    name: 'registration_link',
    async handle(database, ctx) {
      const pasted = registrationLinkIn(ctx.body);
      if (!pasted || !f14EnabledFor(ctx.familyId)) return { claimed: false };
      const [member] = await database
        .select({ role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(
          and(
            eq(schema.familyMembers.familyId, ctx.familyId),
            eq(schema.familyMembers.userId, ctx.parentUserId),
          ),
        );
      if (member?.role !== 'primary_parent' && member?.role !== 'co_parent')
        return { claimed: false };
      let sourceUrl: string;
      try {
        const spot = sanitizeSpotUrl(pasted);
        sourceUrl = registrationPageUrl(spot.ok ? spot.url : pasted);
      } catch {
        return {
          claimed: true,
          outcome: 'unsafe_registration_url',
          reply: 'Please send a public HTTPS course page without login credentials.',
        };
      }
      const request = await ports.readRequest({ text: ctx.body, sourceUrl, location: null });
      if (!request || request.intent === 'none' || request.confidence !== 'high')
        return { claimed: false };
      const wantsReminder = request.intent === 'remind';
      const spot = sanitizeSpotUrl(sourceUrl);
      if (spot.ok) {
        const preparing = await loadPreparingSequence(database, ctx.familyId, ctx.now);
        if (preparing?.municipality === SPOT_PORTAL_HOSTS[spot.host]?.municipality)
          return { claimed: false };
      }
      const givenZone =
        ctx.body.match(
          /\b(?:America|Europe|Asia|Australia|Pacific|Africa)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/,
        )?.[0] ?? null;
      let timeZone: string | null = givenZone;
      try {
        if (timeZone) new Intl.DateTimeFormat('en-US', { timeZone });
      } catch {
        timeZone = null;
      }
      const reading = await ports.reader()(
        {
          sourceUrl,
          municipality: new URL(sourceUrl).hostname,
          cycleLabel: 'the single course shown on this page',
          programDomain: 'course',
          timeZone,
        },
        ctx.now,
      );
      const date = registrationDate(reading, false);
      const unclassified = unclassifiedRegistrationDate(reading);
      if (date && registrationHasOpened(reading, date, ctx.now)) {
        // The existing PerfectMind spot flow owns courses already open.
        if (sanitizeSpotUrl(sourceUrl).ok) return { claimed: false };
        return {
          claimed: true,
          outcome: 'registration_already_open',
          reply: `The page lists ${registrationWhen(reading, date)}, already past. Check current registration here: ${sourceUrl}`,
        };
      }
      const claimed = await claimRegistrationWatch(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        sourceUrl,
        now: ctx.now,
      });
      const lease = await claimRegistrationSend(database, claimed.sequenceId, ctx.now);
      if (lease === null)
        return {
          claimed: true,
          outcome: 'registration_watch_busy',
          reply: 'I am checking this course. Please try again shortly.',
        };
      try {
        await refreshRegistrationWatch(database, {
          sequenceId: claimed.sequenceId,
          reading,
          resident: false,
          now: ctx.now,
        });
        const [watch] = await database
          .select({ actionId: schema.registrationSequences.actionId })
          .from(schema.registrationSequences)
          .where(
            and(
              eq(schema.registrationSequences.id, claimed.sequenceId),
              eq(schema.registrationSequences.familyId, ctx.familyId),
            ),
          );
        const fact = date
          ? `The page says ${registrationWhen(reading, date)}.`
          : unclassified
            ? `The page lists ${registrationWhen(reading, unclassified)}; resident/non-resident eligibility is unconfirmed. I can't confirm this applies to you. Date reminders are paused.`
            : reading.status === 'unverified' && reading.reason === 'unknown_time_zone'
              ? 'Please resend the link with the venue timezone (for example America/New_York or Europe/London).'
              : reading.status === 'unverified'
                ? 'I could not verify a published registration date yet.'
                : 'I could not read the registration page right now.';
        let actionId = watch?.actionId ?? null;
        const previous = actionId
          ? (
              await database
                .select({ revertedAt: schema.actions.revertedAt })
                .from(schema.actions)
                .where(
                  and(eq(schema.actions.id, actionId), eq(schema.actions.familyId, ctx.familyId)),
                )
            )[0]
          : null;
        if (previous?.revertedAt && !wantsReminder) {
          return {
            claimed: true,
            outcome: 'registration_reminder_declined',
            reply: `${fact} This reminder plan was declined. You can ask for a new plan with this course link. ${sourceUrl}`,
          };
        }
        if (!actionId || previous?.revertedAt) {
          actionId = await ports.draft(database, {
            familyId: ctx.familyId,
            parentUserId: ctx.parentUserId,
            sourceUrl,
            summary: unclassified
              ? `${fact} Approve to keep watching; date reminders stay paused until an applicable date is verified. Dates are checked on the page before sending. Hale never registers or pays for you.`
              : `${fact} Approve to receive a reminder a week ahead and the evening before${date?.time ? ', plus fifteen minutes before opening' : '; no minute-specific reminder unless the page publishes an opening time'}. Dates are checked on the page before sending. Hale never registers or pays for you.`,
          });
          const attached = await database.transaction(async (tx) => {
            const [updated] = await tx
              .update(schema.registrationSequences)
              .set({ actionId, updatedAt: ctx.now })
              .where(
                and(
                  eq(schema.registrationSequences.id, claimed.sequenceId),
                  watch?.actionId
                    ? eq(schema.registrationSequences.actionId, watch.actionId)
                    : isNull(schema.registrationSequences.actionId),
                ),
              )
              .returning({ id: schema.registrationSequences.id });
            if (!updated) {
              await tx
                .update(schema.actions)
                .set({
                  revertedAt: ctx.now,
                  revertedReason: 'registration_proposal_changed',
                  userVisibleState: 'reverted',
                })
                .where(
                  and(eq(schema.actions.id, actionId!), eq(schema.actions.familyId, ctx.familyId)),
                );
              return false;
            }
            await tx.insert(schema.auditLog).values({
              familyId: ctx.familyId,
              actor: ctx.parentUserId,
              actionTaken: 'registration_reminder_proposed',
              targetTable: 'registration_sequences',
              targetId: claimed.sequenceId,
              after: { actionId },
              occurredAt: ctx.now,
            });
            return true;
          });
          if (!attached)
            return {
              claimed: true,
              outcome: 'registration_proposal_changed',
              reply:
                'This reminder proposal changed while I checked it. Please resend the course link.',
            };
        }
        if (wantsReminder) {
          const [action] = await database
            .select({
              executedAt: schema.actions.executedAt,
              revertedAt: schema.actions.revertedAt,
            })
            .from(schema.actions)
            .where(and(eq(schema.actions.id, actionId), eq(schema.actions.familyId, ctx.familyId)));
          if (!action?.executedAt && !action?.revertedAt)
            await ports.approve(database, {
              familyId: ctx.familyId,
              actionId,
              approvedBy: ctx.parentUserId,
            });
          return {
            claimed: true,
            outcome: 'registration_reminder_requested',
            reply: `${fact} Your reminder request is recorded and goes through the approval checks. ${sourceUrl}`,
          };
        }
        return {
          claimed: true,
          outcome: 'registration_reminder_proposed',
          reply: `${fact} I saved this course and its reminder proposal; the full reminders need your confirmation in approvals. ${sourceUrl}`,
        };
      } finally {
        await releaseRegistrationSend(database, claimed.sequenceId, lease);
      }
    },
  };
}
