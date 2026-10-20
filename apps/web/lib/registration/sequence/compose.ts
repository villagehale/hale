import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { pipelineClient } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { LiveRegistrationReading } from '../live-reading';
import { registrationDate } from '../read';
import type { LegCopyInput } from './copy';
import { openingFact, verifyMessageDates } from './message-dates';
import { courseSignInUrl } from './prepare';
import type { RegistrationChange } from './refresh';
import type { SequenceLeg } from './schedule';

export interface RegistrationReminderInput {
  leg: SequenceLeg;
  reading: LiveRegistrationReading;
  resident: boolean;
  copy: LegCopyInput;
  change: RegistrationChange | null;
  language?: string;
}

/** Live facts only; no family IDs, names, birthdays, postal codes or cached window dates. */
export function registrationReminderContext(input: RegistrationReminderInput) {
  const { reading, copy, change } = input;
  const date = change ? change.date : registrationDate(reading, input.resident);
  const timeZone = change ? change.timeZone : reading.timeZone;
  const prep = copy.prep?.verdict;
  return {
    leg: input.leg,
    language: input.language ?? 'en',
    now: copy.now.toISOString(),
    parentTimeZone: copy.timeZone,
    opening: openingFact(date, timeZone),
    sourceUrl: change?.sourceUrl ?? reading.sourceUrl,
    sourceStatus: reading.status,
    eligibility: date?.kind ?? null,
    optIn: copy.optIn,
    readinessReportedByParent: copy.readinessReady,
    change: change ? { kind: change.kind } : null,
    waitlistReportedByParent: copy.waitlist ?? null,
    course: prep
      ? {
          status: prep.kind,
          ...('facts' in prep ? { facts: prep.facts, ageFit: prep.age.fit } : {}),
          ...('availability' in prep && prep.availability
            ? {
                availability: {
                  state: prep.availability.state,
                  reason: 'reason' in prep.availability ? prep.availability.reason : null,
                  evidence: 'evidence' in prep.availability ? prep.availability.evidence : [],
                },
              }
            : {}),
          sourceUrl: copy.prep!.courseUrl,
          signInUrl: courseSignInUrl(copy.prep!.courseUrl),
        }
      : null,
    setup: copy.portal
      ? { portal: copy.portal.portalLabel, account: copy.portal.accountLabel }
      : null,
  };
}

const schema = z.object({ message: z.string().trim().min(1) });

/** A failed writer defers the leg; it never falls back to a fixed parent-facing template. */
export async function composeRegistrationReminder(
  input: RegistrationReminderInput,
  client?: AgentClient,
): Promise<string | null> {
  try {
    const context = registrationReminderContext(input);
    const skill = await loadCronSkill('registration-reminder');
    const lane = pickLane(skill.meta.task);
    const { value } = await forceToolJson({
      client: client ?? pipelineClient(),
      lane,
      system: skill.instructions,
      userMessage: JSON.stringify(context),
      toolName: 'registration_reminder',
      toolDescription: 'Write the reminder using only the supplied live facts.',
      inputJsonSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
      schema,
      maxTokens: 2048,
    });
    const body = value.message;
    const allowed = new Set([
      context.sourceUrl,
      context.course?.sourceUrl,
      context.course?.signInUrl,
    ]);
    const urls = body.match(/https?:\/\/[^\s<>]+/g) ?? [];
    if (urls.some((url) => !allowed.has(url.replace(/[.,;!?]+$/, '')))) return null;
    // Compare independently parsed values, not a prescribed parent-facing date string.
    const date = input.change ? input.change.date : registrationDate(input.reading, input.resident);
    const zone = input.change ? input.change.timeZone : input.reading.timeZone;
    if (
      !(await verifyMessageDates(
        body,
        input.copy.now,
        openingFact(date, zone),
        input.reading.status === 'verified'
          ? input.reading.dates.map((date) => openingFact(date, input.reading.timeZone)!)
          : [],
        client ?? pipelineClient(),
      ))
    )
      return null;
    return body.includes(context.sourceUrl) ? body : `${body}\n${context.sourceUrl}`;
  } catch (error) {
    console.error(
      { reason: error instanceof Error ? error.constructor.name : 'unknown' },
      'registration reminder: writer unavailable',
    );
    return null;
  }
}
