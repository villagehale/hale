import type {
  Channel,
  ChannelKind,
  ChannelSendOutcome,
  RenderedContent,
  TemplateRenderer,
} from './types';

/**
 * Fakes for the channel seam (VIL-213 · A2). The dispatch policy is tested against
 * these — no live provider — per the ticket's "business logic tested against Fakes".
 */

export interface FakeChannel extends Channel {
  readonly calls: { userId: string; rendered: RenderedContent }[];
}

/** A programmable Channel: records every send + returns a scripted outcome. */
export function fakeChannel(
  kind: ChannelKind,
  outcome: ChannelSendOutcome = { status: 'sent', providerMessageId: `${kind}-msg-1` },
): FakeChannel {
  const calls: { userId: string; rendered: RenderedContent }[] = [];
  return {
    kind,
    calls,
    async send(input) {
      calls.push(input);
      return outcome;
    },
  };
}

/** A trivial renderer — real per-template content lives with B2/D1/E3. */
export const fakeRenderer: TemplateRenderer = {
  render(message, channel) {
    if (channel === 'email') {
      return { kind: 'email', subject: message.templateKey, html: '', text: message.templateKey };
    }
    if (channel === 'sms') {
      return { kind: 'sms', text: message.templateKey };
    }
    return { kind: 'push', title: message.templateKey, body: '' };
  },
};
