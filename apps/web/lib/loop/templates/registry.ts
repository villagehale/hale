import { defaultLoopRenderer } from '~/lib/channel/renderer';
import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { CALENDAR_CANCEL_SMS_TEMPLATE_KEY, calendarCancelSmsRenderer } from './calendar-cancel/sms';
import { CALENDAR_INVITE_SMS_TEMPLATE_KEY, calendarInviteSmsRenderer } from './calendar-invite/sms';
import { caregiverReminderRenderer } from './caregiver';
import { CAREGIVER_REMINDER_TEMPLATE_KEY } from './caregiver/keys';
import { reminderRenderer } from './reminder';

/**
 * VIL-218 · B2 — the loop template registry. The single TemplateRenderer the A2
 * dispatch injects: it switches on `templateKey` to the right template renderer and
 * falls back to the seam's defaultLoopRenderer for keys that have not registered a
 * real template yet (E3 alerts).
 */

export const REMINDER_TEMPLATE_KEY = 'reminder';

export const loopTemplateRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind, nameLevel: ChildNameLevel): RenderedContent {
    if (message.templateKey === REMINDER_TEMPLATE_KEY) {
      return reminderRenderer.render(message, channel, nameLevel);
    }
    if (message.templateKey === CALENDAR_INVITE_SMS_TEMPLATE_KEY) {
      return calendarInviteSmsRenderer.render(message, channel, nameLevel);
    }
    if (message.templateKey === CALENDAR_CANCEL_SMS_TEMPLATE_KEY) {
      return calendarCancelSmsRenderer.render(message, channel, nameLevel);
    }
    // The caregiver twin. Registered rather than left to the fallback on purpose: an
    // unregistered key renders `defaultLoopRenderer`, which would text a grandmother a
    // generic shell and report it as a successful send.
    if (message.templateKey === CAREGIVER_REMINDER_TEMPLATE_KEY) {
      return caregiverReminderRenderer.render(message, channel, nameLevel);
    }
    return defaultLoopRenderer.render(message, channel, nameLevel);
  },
};
