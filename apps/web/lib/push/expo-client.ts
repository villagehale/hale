/**
 * The Expo push transport, behind an interface so a send is testable without the
 * network. `send` posts a batch of messages to Expo's push API and returns one
 * ticket per message, in order. A ticket with status 'error' and
 * details.error === 'DeviceNotRegistered' means that device's token is dead and
 * should be pruned (see lib/push/send).
 *
 * Privacy (rule #1): the messages carry the notification title/body (never a
 * child's raw content — the caller composes safe copy) and the device token as the
 * address; nothing here is logged.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

export interface ExpoPushClient {
  send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

export function createExpoPushClient(): ExpoPushClient {
  return {
    async send(messages) {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        throw new Error(`Expo push send failed (${res.status})`);
      }
      const payload = (await res.json()) as { data?: ExpoPushTicket[] };
      return payload.data ?? [];
    },
  };
}
