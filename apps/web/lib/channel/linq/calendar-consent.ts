import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { claimOpsPage } from '~/lib/monitoring/ops-page-claim';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { pipelineClient } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * Whether a co-parent wants the kids' stuff on their calendar.
 *
 * The model reads the reply. Code does not match keywords. A `yes` is sent on
 * only when the model echoed the reply exactly and its confidence clears the
 * floor. Anything else is not a yes. Two failed reads page #ops and send nothing.
 */

const SKILL = 'calendar-consent';
const MAX_TOKENS = 256;
export const CALENDAR_CONSENT_CONFIDENCE = 0.7;

const LABELS = ['yes', 'no', 'other'] as const;
export type CalendarConsentLabel = (typeof LABELS)[number];

export type CalendarConsentResult =
  | { status: 'read'; label: CalendarConsentLabel }
  | { status: 'unread' };

export interface CalendarConsentReadInput {
  reply: string;
  scope?: { familyId: string; database?: Database };
}

export interface CalendarConsentReader {
  read(input: CalendarConsentReadInput): Promise<CalendarConsentResult>;
}

const consentSchema = z
  .object({
    label: z.enum(LABELS),
    verbatim: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const consentJsonSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: [...LABELS] },
    verbatim: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['label', 'verbatim', 'confidence'],
} as const;

/** A confident yes that echoes the reply. Any other settled reading is not a yes. */
export function settleCalendarConsent(
  value: { label: CalendarConsentLabel; verbatim: string; confidence: number },
  reply: string,
): CalendarConsentLabel {
  if (value.label !== 'yes') return value.label;
  if (value.verbatim !== reply) return 'other';
  if (value.confidence < CALENDAR_CONSENT_CONFIDENCE) return 'other';
  return 'yes';
}

export function calendarConsentUserMessage(reply: string): string {
  return JSON.stringify({ reply });
}

interface CalendarConsentReaderOptions {
  client?: AgentClient;
  page?: (text: string) => Promise<unknown>;
}

export function createCalendarConsentReader(
  options: CalendarConsentReaderOptions = {},
): CalendarConsentReader {
  return {
    async read(input) {
      const page = async (reason: string): Promise<void> => {
        console.error(
          { skill: SKILL, reason, familyId: input.scope?.familyId ?? null },
          'calendar consent unread',
        );
        try {
          if (input.scope?.database && input.scope.familyId) {
            const claimed = await claimOpsPage(
              input.scope.database,
              `calendar-consent:${input.scope.familyId}`,
            );
            if (!claimed) return;
          }
          await (options.page ?? postOpsSlack)(
            `calendar consent unread skill=${SKILL} reason=${reason}`,
          );
        } catch (err) {
          console.error(
            { err: err instanceof Error ? err.name : 'unknown', skill: SKILL },
            'calendar consent: ops page failed',
          );
        }
      };

      let client: AgentClient;
      try {
        client = options.client ?? pipelineClient();
      } catch {
        await page('voice_unavailable');
        return { status: 'unread' };
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SKILL);
      } catch {
        await page('skill_unavailable');
        return { status: 'unread' };
      }

      let last = 'model_failed';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { value } = await forceToolJson({
            client,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: calendarConsentUserMessage(input.reply),
            toolName: 'calendar_consent',
            toolDescription: 'Read whether the parent wants the kids’ stuff on their calendar.',
            inputJsonSchema: consentJsonSchema,
            schema: consentSchema,
            maxTokens: MAX_TOKENS,
          });
          return { status: 'read', label: settleCalendarConsent(value, input.reply) };
        } catch (err) {
          last = err instanceof Error ? err.name : 'model_failed';
        }
      }
      await page(last);
      return { status: 'unread' };
    },
  };
}

export function defaultCalendarConsentReader(): CalendarConsentReader {
  return createCalendarConsentReader();
}
