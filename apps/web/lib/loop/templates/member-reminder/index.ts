import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';

/**
 * VIL-448 (T26) — the 1:1 text of a reminder a parent asked for in their family group.
 * The model wrote the whole text from the parent's own ask (loop/reminders/group/voice.ts),
 * and this renderer adds nothing. A payload with no text is a wiring bug: it fails loud
 * rather than falling to a generic line.
 */
export const MEMBER_REMINDER_TEMPLATE_KEY = 'member_reminder';

export const memberReminderRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind, _nameLevel: ChildNameLevel): RenderedContent {
    const text = message.payload.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('member reminder payload: missing text');
    }
    switch (channel) {
      case 'sms':
        return { kind: 'sms', text, recordBody: true };
      default: {
        const exhaustive: never = channel;
        throw new Error(`member reminder renderer: unsupported channel ${String(exhaustive)}`);
      }
    }
  },
};
