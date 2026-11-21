import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { isParentHeld } from '~/lib/channel/intake/opt-out-hold';
import { buildOutboundGatePorts, proactiveFloorClosedUntil } from '~/lib/channel/outbound-gate';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { proactiveSendsPaused } from '~/lib/channel/proactive/flag';
import { createReplyTransport } from '~/lib/channel/router/reply-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { pageOps } from '~/lib/monitoring/failure-page';
import { ACK_NOTE_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import type { AckEtaRouterPorts, AckUnwrittenPage } from './arm';
import { type AckComposeFallback, createAckLineWriter } from './compose';
import { ackEtaEnabled } from './flag';
import { recordAckPromise } from './promise';
import { createAckTaskReader } from './read';
import type { AckDeadlinePorts, AckSendRail } from './sweep';

/**
 * VIL-717 · the production ports: the model client, the send rails, the Linq doors and the
 * #ops pager. Kept out of the modules the tests drive, so a test of the gate or the sweep
 * never builds a real client or transport.
 */

/** #ops, through the one pager, once per hour for this site (failure-page.ts). */
async function pageUnwritten(
  database: Database,
  page: AckUnwrittenPage | { stage: 'late_note'; reason: AckComposeFallback },
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
    page: pageUnwritten,
  };
}

let noteAnthropic: Anthropic | undefined;

/** The sweep's client, built the first time a note is written (never on a quiet tick). */
function noteClient(): AgentClient {
  noteAnthropic ??= budgetedAnthropic(ACK_NOTE_CLIENT_OPTIONS, { stage: 'notice' });
  return noteAnthropic;
}

/**
 * The rails a late note passes before it is written: the operator pause and an unread
 * opt-out. A live channel is the phone port's: a revoked or unverified one has no number
 * (sms-consent-core.ts `resolveSendablePhone`), so it cannot be texted at all.
 */
async function noteRail(database: Database, parentUserId: string): Promise<AckSendRail> {
  if (proactiveSendsPaused()) return 'sends_paused';
  if (await isParentHeld(database, parentUserId)) return 'opt_out_unread';
  return 'clear';
}

/** The deadline sweep's production ports (drain leg, app/api/cron/drain/route.ts). */
export function ackDeadlinePorts(database: Database): AckDeadlinePorts {
  return {
    enabled: (familyId) => ackEtaEnabled(familyId),
    clock: () => Date.now(),
    writer: createAckLineWriter(noteClient),
    quietUntil: (parentUserId, now) =>
      proactiveFloorClosedUntil(buildOutboundGatePorts(database), parentUserId, now),
    rail: (parentUserId) => noteRail(database, parentUserId),
    phone: (parentUserId) => resolveSendablePhone(database, parentUserId),
    // The router's own way out: Linq for both doors, the 1:1 chat on iMessage.
    transport: createReplyTransport({ phone: createOutboundTransport() }),
    page: (page) => pageUnwritten(database, page),
    thread: (input) => threadProactiveMessage(database, input),
    log: console,
  };
}
