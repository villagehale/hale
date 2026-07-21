import { defaultLoopRenderer } from '~/lib/channel/renderer';
import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { weeklyPlanRenderer } from './weekly-plan';

/**
 * VIL-218 · B2 — the loop template registry. The single TemplateRenderer the A2
 * dispatch injects: it switches on `templateKey` to the right template renderer and
 * falls back to the seam's defaultLoopRenderer for keys that have not registered a
 * real template yet (D1 reminders, E3 alerts).
 */

export const WEEKLY_PLAN_TEMPLATE_KEY = 'weekly_plan';

export const loopTemplateRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind, nameLevel: ChildNameLevel): RenderedContent {
    if (message.templateKey === WEEKLY_PLAN_TEMPLATE_KEY) {
      return weeklyPlanRenderer.render(message, channel, nameLevel);
    }
    return defaultLoopRenderer.render(message, channel, nameLevel);
  },
};
