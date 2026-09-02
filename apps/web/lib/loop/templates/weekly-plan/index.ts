import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { renderWeeklyPlanEmail } from './email';
import { asWeeklyPlanPayload } from './payload';
import { renderWeeklyPlanSms } from './sms';

/**
 * VIL-218 · B2 — the weekly_plan TemplateRenderer. Reads the typed payload off the
 * A2 LoopMessage, resolves the render clock once, and dispatches to the per-channel
 * renderer, threading the parent's resolved child_name_level (the teen gate is then
 * composed per child by loopChildName inside the helpers).
 */
export const weeklyPlanRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind, nameLevel: ChildNameLevel): RenderedContent {
    const payload = asWeeklyPlanPayload(message.payload);
    const now = new Date();
    switch (channel) {
      case 'email':
        return renderWeeklyPlanEmail(payload, nameLevel, now);
      case 'sms':
        return renderWeeklyPlanSms(payload, nameLevel, now);
      // A reply pipe, not a proactive one: the dispatch refuses a whatsapp leg
      // before any render (channel/dispatch.ts), so reaching here is a routing bug.
      case 'whatsapp':
        throw new Error('weekly_plan renderer: whatsapp is a reply pipe — no proactive render');
      default: {
        const exhaustive: never = channel;
        throw new Error(`weekly_plan renderer: unsupported channel ${String(exhaustive)}`);
      }
    }
  },
};
