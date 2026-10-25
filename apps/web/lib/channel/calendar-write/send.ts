import { type Database, schema } from '@hale/db';
import type {
  GoogleCalendarPlacement,
  GoogleCalendarPlacementRequest,
  GoogleCalendarSyncReport,
} from '@hale/worker/google-calendar-placement';
import { eq } from 'drizzle-orm';
import { offerConnectorLink } from '~/lib/channel/connect/offer';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { sendLinqChatMessage } from '~/lib/channel/linq/transport';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import {
  createOutboundTransport,
  failedSendPatch,
  readSendRefusal,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { composeEventCancel } from '~/lib/loop/ics-invite';
import { inviteWhenLabel } from '~/lib/loop/templates/calendar-invite/sms';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import {
  type CalendarWriteEvent,
  type CalendarWriteNoticeInput,
  calendarWriteNoticeEnabled,
  calendarWriteNoticeInput,
  calendarWriteOutcome,
  composeCalendarWriteNotice,
} from './notice';

/**
 * VIL-454 (T6) 2/3 — send the write-outcome notice after the Google leg.
 *
 * A decorator on the executor's Google placement port: `sync` runs exactly as before and
 * its report is returned untouched, so nothing here can change or fail a placement. Only
 * when `CALENDAR_WRITE_NOTICE_ENABLED` is exactly `true` AND a parent approved the write
 * (an `actorUserId`, i.e. a 1:1 agreement; an autonomous pass has none) does it compose
 * the AI-written notice and text it to that parent alone. A connect link is minted only
 * for an outcome that needs one. Every way this ends is logged (rule #11); nothing is
 * thrown.
 */

export const CALENDAR_WRITE_NOTICE_TEMPLATE_KEY = 'calendar_write_notice';

export type NoticeSendOutcome = 'sent' | 'no_send_target' | 'no_chat' | 'send_failed' | 'errored';

export interface CalendarWriteNoticePorts {
  enabled(): boolean;
  /** The event as this parent may see it, or null when it can't be read. */
  loadEvent(request: GoogleCalendarPlacementRequest & { actorUserId: string }): Promise<{
    event: CalendarWriteEvent;
    language: ReplyLanguage;
  } | null>;
  /** A one-tap calendar connect link for this parent, or null when none could be minted. */
  connectLink(familyId: string, parentUserId: string): Promise<string | null>;
  compose(input: CalendarWriteNoticeInput): Promise<string | null>;
  send(familyId: string, parentUserId: string, text: string): Promise<NoticeSendOutcome>;
}

export type CalendarWriteNoticeResult =
  | 'disabled'
  | 'no_actor'
  | 'no_news'
  | 'event_unreadable'
  | 'no_link'
  | 'unwritten'
  | NoticeSendOutcome;

/** Exported for tests: the notice leg for one finished sync. Never throws. */
export async function noticeAfterSync(
  request: GoogleCalendarPlacementRequest,
  report: GoogleCalendarSyncReport,
  ports: CalendarWriteNoticePorts,
): Promise<CalendarWriteNoticeResult> {
  try {
    if (!ports.enabled()) return 'disabled';
    const actorUserId = request.actorUserId;
    if (!actorUserId) return 'no_actor';
    const outcome = calendarWriteOutcome(request.op, report);
    if (!outcome) return 'no_news';
    const loaded = await ports.loadEvent({ ...request, actorUserId });
    if (!loaded) return 'event_unreadable';
    const needsLink =
      outcome === 'no_calendar' || outcome === 'needs_permission' || outcome === 'needs_reconnect';
    const link = needsLink ? await ports.connectLink(request.familyId, actorUserId) : null;
    const input = calendarWriteNoticeInput({
      op: request.op,
      report,
      event: loaded.event,
      connectLink: link,
      language: loaded.language,
    });
    if (!input) return 'no_link';
    const text = await ports.compose(input);
    if (!text) return 'unwritten';
    return await ports.send(request.familyId, actorUserId, text);
  } catch (err) {
    console.error(
      { familyId: request.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'calendar write notice: threw, placement unaffected',
    );
    return 'errored';
  }
}

export function withCalendarWriteNotice(
  inner: GoogleCalendarPlacement,
  ports: CalendarWriteNoticePorts,
): GoogleCalendarPlacement {
  return {
    async sync(request) {
      const report = await inner.sync(request);
      const result = await noticeAfterSync(request, report, ports);
      console.info(
        { familyId: request.familyId, op: request.op, result },
        'calendar write notice: done',
      );
      return report;
    },
  };
}

async function familyLanguage(database: Database, familyId: string): Promise<ReplyLanguage> {
  const [row] = await database
    .select({ primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.primaryLanguage ?? 'en';
}

async function familyGroupChatId(database: Database, familyId: string): Promise<string | null> {
  const [row] = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.linqGroupChatId ?? null;
}

async function parentTimezone(database: Database, userId: string): Promise<string> {
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.timezone ?? 'America/Toronto';
}

/** Production ports. The send is a 1:1 text on the parent's own door, never the group. */
export function productionCalendarWriteNoticePorts(database: Database): CalendarWriteNoticePorts {
  const transport = createOutboundTransport();
  return {
    enabled: () => calendarWriteNoticeEnabled(),
    async loadEvent(request) {
      const composed = await composeEventCancel(
        {
          familyId: request.familyId,
          familyEventId: request.familyEventId,
          parentUserId: request.actorUserId,
        },
        { database },
      );
      if (composed.status !== 'composed') return null;
      const timezone = await parentTimezone(database, request.actorUserId);
      return {
        // Rendered at this parent's own privacy level; the place is left out on purpose.
        event: {
          title: composed.summary,
          when: inviteWhenLabel(composed.startsAt, timezone),
          where: null,
        },
        language: await familyLanguage(database, request.familyId),
      };
    },
    async connectLink(familyId, parentUserId) {
      const minted = await offerConnectorLink(database, {
        familyId,
        parentUserId,
        provider: 'gcal',
        now: new Date(),
      });
      return minted.status === 'minted' ? minted.url : null;
    },
    compose: (input) =>
      composeCalendarWriteNotice(budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS), input),
    async send(familyId, parentUserId, text) {
      const phone = await resolveSendablePhone(database, parentUserId);
      if (!phone) return 'no_send_target';
      const door = await resolveMessagingDoor(database, parentUserId, {
        excludeChatId: await familyGroupChatId(database, familyId),
      });
      const chatId = door.channel === 'imessage' ? door.chatId : null;
      if (door.channel === 'imessage' && !chatId) return 'no_chat';
      const channel = door.channel === 'imessage' ? 'imessage' : 'sms';
      const now = new Date();
      const [claimed] = await database
        .insert(schema.channelMessages)
        .values({
          familyId,
          parentUserId,
          channel,
          direction: 'out',
          category: 'reply',
          templateKey: CALENDAR_WRITE_NOTICE_TEMPLATE_KEY,
          providerChatId: chatId,
          status: acceptedStatus(channel),
          sentAt: now,
        })
        .returning({ id: schema.channelMessages.id });
      if (!claimed) return 'errored';
      let providerMessageId: string;
      try {
        if (chatId) {
          ({ providerMessageId } = await sendLinqChatMessage({ chatId, text }));
        } else {
          ({ providerMessageId } = await sendResolvingNewChat(transport, {
            to: phone,
            body: text,
          }));
        }
      } catch (err) {
        const code = readSendRefusal(err)?.code ?? 'unknown';
        await database
          .update(schema.channelMessages)
          .set(failedSendPatch(code))
          .where(eq(schema.channelMessages.id, claimed.id));
        return 'send_failed';
      }
      await database
        .update(schema.channelMessages)
        .set({ providerMessageId })
        .where(eq(schema.channelMessages.id, claimed.id));
      await threadProactiveMessage(database, { familyId, parentUserId, body: text });
      return 'sent';
    },
  };
}
