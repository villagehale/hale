import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from '~/lib/channel/types';
import { asCaregiverPlanPayload, asCaregiverReminderPayload } from './payload';
import { renderCaregiverPlanSms } from './plan-sms';
import { renderCaregiverReminderSms } from './reminder-sms';

/**
 * The two caregiver TemplateRenderers.
 *
 * SMS ONLY, and it throws on anything else rather than falling through to an email
 * shell. A caregiver's users row is minted from a phone number and has no address
 * (channel/caregiver/invites.ts `ensureCaregiverUser`), so an email leg for one of these
 * messages is a routing bug — the sender pins `channel: 'sms'` — and the loud failure is
 * how that bug surfaces instead of becoming a weekly `no_address` row.
 */

function smsOnly(
  channel: ChannelKind,
  render: () => RenderedContent,
  what: string,
): RenderedContent {
  if (channel !== 'sms') {
    throw new Error(`${what}: caregivers have no address - sms only, got ${channel}`);
  }
  return render();
}

export const caregiverPlanRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    return smsOnly(
      channel,
      () => renderCaregiverPlanSms(asCaregiverPlanPayload(message.payload)),
      'caregiver plan renderer',
    );
  },
};

export const caregiverReminderRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    return smsOnly(
      channel,
      () => renderCaregiverReminderSms(asCaregiverReminderPayload(message.payload)),
      'caregiver reminder renderer',
    );
  },
};
