import { type RegisteredTool, defineTool } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import type { OfferedCandidate } from '~/lib/coach/tools';
import { zonedLocalInstant } from '~/lib/plan/spine';
import { queueSaidSignupAsk } from './sweep';

/**
 * VIL-393 · the parent said they signed up for something, in any words. The coach
 * model decides that; code matches no phrase. This verb queues the one ask for the
 * evening after the first session (sweep.ts `queueSaidSignupAsk`) and says nothing.
 *
 * Registered only while MID_ACTIVITY_SIGNUP_TOOL_ENABLED is exactly `true`: a new
 * verb changes the coach's tool list, and with it every cached coach eval key, so it
 * stays off until those evals are re-recorded and reviewed.
 */

export const MID_ACTIVITY_SIGNUP_TOOL_ENV = 'MID_ACTIVITY_SIGNUP_TOOL_ENABLED';

export function midActivitySignupToolEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MID_ACTIVITY_SIGNUP_TOOL_ENV] === 'true';
}

export interface SaidSignupToolPorts {
  database: Database;
  familyId: string;
  parentUserId: string;
  now: Date;
  timeZone(): Promise<string>;
  /** What search_village offered this turn, so a named pick keeps its recommendation. */
  offeredThisTurn?: () => readonly OfferedCandidate[];
}

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const wallClock = z.string().regex(/^\d{2}:\d{2}$/);

export function noteActivitySignupTool(ports: SaidSignupToolPorts): RegisteredTool {
  return defineTool({
    name: 'note_activity_signup',
    description:
      "Call when the parent tells you they signed a child up for a class or activity and you know when the first session is. `date`/`time` are the family's own wall clock for the first session; `end_time` when they said it. Hale checks in once, later. Nothing is sent now.",
    inputSchema: z.object({
      title: z.string().min(1).max(120),
      date: dayKey,
      time: wallClock,
      end_time: wallClock.optional(),
    }),
    inputExamples: [{ title: 'Swim lesson', date: '2026-09-15', time: '17:15' }],
    monetary: false,
    touchesChildContent: false,
    handler: async (input) => {
      const timeZone = await ports.timeZone();
      const startsAt = zonedLocalInstant(input.date, input.time, timeZone);
      const endsAt = input.end_time
        ? zonedLocalInstant(input.date, input.end_time, timeZone)
        : null;
      const wanted = input.title.trim().toLowerCase();
      const offered = (ports.offeredThisTurn?.() ?? []).find(
        (offer) => offer.title.trim().toLowerCase() === wanted && offer.candidateId,
      );
      const outcome = await queueSaidSignupAsk(ports.database, {
        familyId: ports.familyId,
        parentUserId: ports.parentUserId,
        title: input.title,
        firstSessionStartsAt: startsAt,
        firstSessionEndsAt: endsAt,
        candidateId: offered?.candidateId ?? null,
        timeZone,
        now: ports.now,
      });
      return { noted: outcome === 'queued' || outcome === 'duplicate' };
    },
  });
}
