import type { AgentClient } from '@hale/agent';
import { PARTY_GUEST_LINE_TOOL } from '~/lib/party/guest-voice';
import { structuredReply } from './structured-reply';

/**
 * A scripted AgentClient for the party guest line's writer. Request MECHANICS only: what
 * the skill writes is the cached eval's job (rule #8). Each entry answers one request, in
 * order. An Error is a failed call, and so is running out of entries.
 */
export function scriptedGuestLineClient(replies: ReadonlyArray<string | Error>) {
  const queue = [...replies];
  const requests: Array<{ model: string; messages: { content: string }[] }> = [];
  const respond = async (request: { model: string; messages: { content: string }[] }) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error('scripted guest line client: no reply left');
    if (next instanceof Error) throw next;
    return structuredReply(
      request,
      PARTY_GUEST_LINE_TOOL.name,
      { text: next },
      {
        input_tokens: 1,
        output_tokens: 1,
      },
    );
  };
  const client = {
    messages: {
      create: respond,
      stream: (request: { model: string; messages: { content: string }[] }) => ({
        finalMessage: () => respond(request),
      }),
    },
  } as unknown as AgentClient;
  return { client, requests };
}
