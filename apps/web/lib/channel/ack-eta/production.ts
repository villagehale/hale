import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { f14EnabledFor } from '~/lib/channel/f14';
import {
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
  proactiveFloorClosedUntil,
} from '~/lib/channel/outbound-gate';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { readLineHold } from '~/lib/channel/proactive/review';
import { createReplyTransport } from '~/lib/channel/router/reply-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { pageOps } from '~/lib/monitoring/failure-page';
import { ACK_NOTE_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import type { AckEtaRouterPorts, AckUnwrittenPage } from './arm';
import { createAckLineWriter } from './compose';
import { ackEtaEnabled } from './flag';
import { ackPromiseFor, recordAckPromise } from './promise';
import { createAckTaskReader } from './read';
import type { AckDeadlinePorts, LateNotePage } from './sweep';

/**
 * VIL-717 · the production ports: the model client, the send rails, the Linq doors and the
 * #ops pager. Kept out of the modules the tests drive, so a test of the gate or the sweep
 * never builds a real client or transport.
 */

/** #ops, through the one pager, once per hour for this site (failure-page.ts). */
async function pageUnwritten(
  database: Database,
  page: AckUnwrittenPage | LateNotePage,
): Promise<unknown> {
  try {
    return await pageOps(database, { site: 'ack_eta_unwritten', facts: page });
  } catch (err) {
    // pageOps names its own failures; a throw here must not take the turn or tick with it.
    console.error(
      { stage: page.stage, err: err instanceof Error ? err.name : 'unknown' },
      'ack eta: the pager threw',
    );
    return 'page_failed';
  }
}

/** The router's ack ports, on the same lazy client the screen and the holding line use. */
export function ackEtaRouterPorts(client: () => AgentClient): AckEtaRouterPorts {
  return {
    reader: createAckTaskReader(client),
    writer: createAckLineWriter(client),
    record: recordAckPromise,
    promiseFor: ackPromiseFor,
    page: pageUnwritten,
  };
}

let noteAnthropic: Anthropic | undefined;

/** The sweep's client, built the first time a note is written (never on a quiet tick). */
function noteClient(): AgentClient {
  noteAnthropic ??= budgetedAnthropic(ACK_NOTE_CLIENT_OPTIONS, { stage: 'notice' });
  return noteAnthropic;
}

/** The deadline sweep's production ports (drain leg, app/api/cron/drain/route.ts). */
export function ackDeadlinePorts(database: Database): AckDeadlinePorts {
  const gatePorts = buildOutboundGatePorts(database);
  return {
    enabled: (familyId) => ackEtaEnabled(familyId),
    f14For: f14EnabledFor,
    clock: () => Date.now(),
    writer: createAckLineWriter(noteClient),
    gate: (request) => assertProactiveSendAllowed({ ...request, kind: 'ack_late_note' }, gatePorts),
    quietUntil: (parentUserId, now) => proactiveFloorClosedUntil(gatePorts, parentUserId, now),
    lineHold: () => readLineHold(database),
    phone: (parentUserId) => resolveSendablePhone(database, parentUserId),
    // The router's own way out: Linq for both doors, the 1:1 chat on iMessage.
    transport: createReplyTransport({ phone: createOutboundTransport() }),
    page: (page) => pageUnwritten(database, page),
    thread: (input) => threadProactiveMessage(database, input),
    log: console,
  };
}
