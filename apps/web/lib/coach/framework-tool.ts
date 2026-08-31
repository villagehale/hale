import { z } from 'zod';
import { type RegisteredTool, defineTool } from '@hale/agent';
import { CONFIRM_WITH_PROVIDER, companionForChild, type FamilyStage } from '@hale/types';

/**
 * The Child Development & Wellbeing Companion as a tool, shared by BOTH coach
 * runtimes. Extracted from lib/coach/tools.ts (2026-08-12) when the skill audit
 * caught the split-brain: coach-channel-sms.md instructed `get_framework_guidance`
 * while the SMS channel coach's registry never carried it — the parenting-coaching
 * restoration (#407) would have been a tool call into a void. One definition,
 * two registries, so the pair can never drift apart again.
 *
 * Reads no child data and no database — pure over the curated companion content —
 * which is also why it is safe in the pre-provisioning and channel contexts.
 */

/**
 * A representative DOB for a stage when no age was given. Mid-stage on purpose:
 * answering for the middle beats answering for an edge, but an age is always the
 * better question to answer — the description begs the model to pass one.
 */
function stageReferenceDob(stage: FamilyStage, ageMonths?: number, now: Date = new Date()): Date {
  const monthsByStage: Record<FamilyStage, number> = {
    newborn: 6,
    toddler: 24,
    preschool: 54,
    child: 96,
    teenager: 168,
  };
  const months = ageMonths ?? monthsByStage[stage];
  // Clamp the day: Date.setMonth(Aug 31 → April) overflows to May 1 and the
  // asked-for age comes back one month young (CI 2026-08-31, VIL-334).
  const year = now.getFullYear();
  const month = now.getMonth() - months;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(now.getDate(), lastDay));
}

export function frameworkGuidanceTool(): RegisteredTool {
  return defineTool({
    name: 'get_framework_guidance',
    description:
      "The Child Development & Wellbeing Companion for a stage: curated 'what matters now' guidance, milestone windows, and the Canadian health/immunization cadence. ALWAYS pass ageMonths when you know the child's age (get_child_profile returns it) — the 'child' stage spans four years old to twelve, and without an age this answers for the middle of it. Every item is general guidance — surface the confirm-with-provider note for anything health-related (rule #1).",
    inputSchema: z.object({
      stage: z.enum(['newborn', 'toddler', 'preschool', 'child', 'teenager']),
      ageMonths: z.number().int().min(0).max(215).optional(),
    }),
    // The 'child' stage spans four to twelve years old, so an age-less call
    // answers for the middle of it. Both examples pass one — invented values
    // only, since examples ride the cached tool-definition grammar (rule #1).
    inputExamples: [
      { stage: 'toddler', ageMonths: 26 },
      { stage: 'child', ageMonths: 68 },
    ],
    monetary: false,
    touchesChildContent: false,
    handler: async (input) => {
      const reference = stageReferenceDob(input.stage, input.ageMonths);
      const companion = companionForChild({ dateOfBirth: reference });
      return {
        stage: companion.stage,
        ageMonths: companion.ageMonths,
        whatsNow: companion.whatsNow,
        whatsNext: companion.whatsNext,
        milestones: companion.milestones.map((m) => ({
          area: m.area,
          what: m.what,
          typicalWindowMonths: m.typicalWindowMonths,
        })),
        nextHealth: companion.nextHealth.map((h) => ({ what: h.what, kind: h.kind })),
        confirmWithProvider: CONFIRM_WITH_PROVIDER,
      };
    },
  });
}
