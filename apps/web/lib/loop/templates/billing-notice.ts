import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';

export const BILLING_NOTICE_TEMPLATE_KEY = 'billing_notice';

/**
 * VIL-735 · a billing notice is the model's whole text. There is nothing to fall back to,
 * so a message without one is a bug that throws rather than a shell that sends.
 */
export const billingNoticeRenderer: TemplateRenderer = {
  render(message: LoopMessage, _channel: ChannelKind): RenderedContent {
    const text = message.payload.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('billing notice renderer: no written text on the message');
    }
    return { kind: 'sms', text, modelWritten: true };
  },
};
