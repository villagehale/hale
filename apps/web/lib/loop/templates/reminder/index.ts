import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { renderReminderEmail } from './email';
import { asReminderPayload } from './payload';
import { renderReminderSms } from './sms';

/**
 * VIL-223 · D1 — the reminder TemplateRenderer. Reads the typed payload off the A2
 * LoopMessage, resolves the render clock once, and dispatches to the per-channel
 * renderer, threading the parent's resolved child_name_level (the teen gate is then
 * composed per child by loopChildName inside the copy helpers).
 */
export const reminderRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind, nameLevel: ChildNameLevel): RenderedContent {
    const payload = asReminderPayload(message.payload);
    const now = new Date();
    switch (channel) {
      case 'email':
        return renderReminderEmail(payload, nameLevel, now);
      case 'sms':
        return renderReminderSms(payload, nameLevel, now);
      // A reply pipe, not a proactive one: the dispatch refuses a whatsapp leg
      // before any render (channel/dispatch.ts), so reaching here is a routing bug.
      case 'whatsapp':
        throw new Error('reminder renderer: whatsapp is a reply pipe — no proactive render');
      default: {
        const exhaustive: never = channel;
        throw new Error(`reminder renderer: unsupported channel ${String(exhaustive)}`);
      }
    }
  },
};
