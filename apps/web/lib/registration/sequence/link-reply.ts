import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { pipelineClient } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { LiveRegistrationReading } from '../live-reading';
import { registrationDate, unclassifiedRegistrationDate } from '../read';
import { openingFact, verifyMessageDates } from './message-dates';

const NEXT_STEP = {
  unsafe_registration_url: 'send_public_https_course_url',
  registration_already_open: 'check_current_registration_on_source',
  registration_watch_busy: 'retry_when_check_finishes',
  registration_reminder_declined: 'request_a_new_plan_if_wanted',
  registration_proposal_changed: 'resend_course_link',
  registration_reminder_requested: 'approval_checks_apply',
  registration_reminder_proposed: 'confirm_plan_in_approvals',
} as const;

export interface RegistrationLinkReplyInput {
  outcome: keyof typeof NEXT_STEP;
  language: string;
  parentWords: string;
  sourceUrl: string | null;
  reading: LiveRegistrationReading | null;
}

export function registrationLinkReplyContext(input: RegistrationLinkReplyInput) {
  const date = input.reading
    ? (registrationDate(input.reading, false) ?? unclassifiedRegistrationDate(input.reading))
    : null;
  const unclassified = date?.kind === 'unclassified_open';
  return {
    outcome: input.outcome,
    language: input.language,
    parentWords: input.parentWords,
    sourceUrl: input.sourceUrl,
    sourceStatus: input.reading?.status ?? null,
    sourceReason: input.reading && 'reason' in input.reading ? input.reading.reason : null,
    opening: openingFact(date, input.reading?.timeZone ?? null),
    eligibility: date?.kind ?? null,
    dateRemindersPaused: unclassified || (input.reading !== null && !date),
    nextStep:
      input.reading?.status === 'unverified' && input.reading.reason === 'unknown_time_zone'
        ? 'provide_venue_timezone'
        : NEXT_STEP[input.outcome],
    reminderPlan: {
      weekAhead: true,
      eveningBefore: true,
      minutesBeforeOpening: date?.time && !unclassified ? 15 : null,
      requiresApproval: true,
      automaticRegistrationOrPayment: false,
    },
  };
}

export async function composeRegistrationLinkReply(
  input: RegistrationLinkReplyInput,
  client?: AgentClient,
): Promise<string | null> {
  try {
    const context = registrationLinkReplyContext(input);
    const skill = await loadCronSkill('registration-link-reply');
    const { value } = await forceToolJson({
      client: client ?? pipelineClient(),
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: JSON.stringify(context),
      toolName: 'registration_link_reply',
      toolDescription:
        'Explain the registration outcome using the supplied facts and parent language.',
      inputJsonSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
      schema: z.object({ message: z.string().trim().min(1) }),
      maxTokens: 2048,
    });
    const urls = value.message.match(/https?:\/\/[^\s<>]+/g) ?? [];
    if (urls.some((url) => url.replace(/[.,;!?]+$/, '') !== context.sourceUrl)) return null;
    const date = input.reading
      ? (registrationDate(input.reading, false) ?? unclassifiedRegistrationDate(input.reading))
      : null;
    if (
      !(await verifyMessageDates(
        value.message,
        input.reading?.checkedAt ?? new Date(),
        openingFact(date, input.reading?.timeZone ?? null),
        input.reading?.status === 'verified'
          ? input.reading.dates.map((date) => openingFact(date, input.reading!.timeZone)!)
          : [],
        client ?? pipelineClient(),
      ))
    )
      return null;
    return context.sourceUrl && !value.message.includes(context.sourceUrl)
      ? `${value.message}\n${context.sourceUrl}`
      : value.message;
  } catch (error) {
    console.error(
      { reason: error instanceof Error ? error.constructor.name : 'unknown' },
      'registration link: writer unavailable',
    );
    return null;
  }
}
