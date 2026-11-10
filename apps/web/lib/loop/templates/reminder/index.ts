import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { asReminderPayload } from './payload';
import { renderReminderSms } from './sms';

/**
 * VIL-223 · D1 — the reminder TemplateRenderer. Reads the typed payload off the A2
 * LoopMessage and hands the model-written text to the per-channel renderer. The name
 * level and teen gate were applied to the facts before the model saw them.
 */
export const reminderRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind, _nameLevel: ChildNameLevel): RenderedContent {
    const payload = asReminderPayload(message.payload);
    switch (channel) {
      case 'sms':
        return renderReminderSms(payload);
      default: {
        const exhaustive: never = channel;
        throw new Error(`reminder renderer: unsupported channel ${String(exhaustive)}`);
      }
    }
  },
};
