import { type Database, schema } from '@hale/db';
import { and, desc, eq, notExists, or } from 'drizzle-orm';
import { googleGetFetch } from '~/lib/cron/connector-sync';
import { integrationAccessToken } from '~/lib/integrations/gmail-draft-service';
import { CONNECTOR_SCOPES } from '~/lib/integrations/google-oauth';
import type { GoogleFetch } from '~/lib/integrations/sync';
import { fetchGmailMessageBody } from '~/lib/sentinel/fetch-body';
import { type MessageHeaders, alignedSenderHost } from './sender';

/**
 * VIL-685 · THE KID MAIL HALE ALREADY READS, as the schools it authenticated as.
 *
 * The mail is the email alerts Hale already sent this family (`email_alert_offers`): mail
 * from a parent's own connected Gmail that the sentinel kept as about the kids and Hale
 * told them about. Mail is left out when it is no longer plain kid mail: any kid-relevance
 * verdict of `adult` (the kid check's, or the parent's own, which is what an untrack such
 * as "that's mine" writes), of `unsure`, or on a 13+ child's mail. A 13+ child's mail
 * writes no offer row either (rule #1).
 *
 * Of those messages only two headers are read, From and `Authentication-Results`, from a
 * connection that is still active and readable. A message names a school only when Gmail
 * says it authenticated as its From domain (sender.ts); the address is reduced to that
 * domain's registrable domain in memory and never written. A message's text is fetched
 * only when the sweep reads the break off it (`text`), held for that one reading, and
 * never stored (`BODY_RETENTION` in sentinel/fetch-body.ts).
 */

/** Messages read per family: the newest alerts. An infra bound, not a rule about mail. */
export const MAX_ALERTED_MESSAGES = 10;

/** One message that authenticated as a school's host. */
export interface SchoolMessage {
  integrationId: string;
  messageId: string;
  host: string;
}

export type SchoolMail =
  | {
      status: 'read';
      /** Newest first. */
      messages: SchoolMessage[];
      /** Messages read whose From domain did not authenticate: never a school. */
      unaligned: number;
    }
  /** Hale has told this family about no kid email it can still read. */
  | { status: 'no_mail' }
  /** Mail was there and could not be read: a token or Google failure, by name. */
  | { status: 'unread'; reason: string };

export type SchoolMailText =
  | { status: 'read'; text: string }
  | { status: 'unread'; reason: string };

export interface SchoolMailPorts {
  /** This family's kept kid-mail alerts, newest first: the connection and the message id. */
  alertedMail(familyId: string): Promise<Array<{ integrationId: string; messageId: string }>>;
  /** The connection is this family's, active, and still holds the read scope. */
  readable(familyId: string, integrationId: string): Promise<boolean>;
  accessToken(integrationId: string): Promise<string | null>;
  /** The message's From and Authentication-Results headers, in order; null when the
   * message is gone. Throws on any other failure. */
  headers(messageId: string, accessToken: string): Promise<MessageHeaders | null>;
  /** The message's text. Throws on any failure. */
  body(messageId: string, accessToken: string): Promise<string>;
}

export interface SchoolMailReader {
  schoolMail(familyId: string): Promise<SchoolMail>;
  text(familyId: string, message: SchoolMessage): Promise<SchoolMailText>;
}

function failureName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export function schoolMailReader(ports: SchoolMailPorts): SchoolMailReader {
  return {
    async schoolMail(familyId) {
      const alerted = await ports.alertedMail(familyId);
      const byConnection = new Map<string, string[]>();
      for (const { integrationId, messageId } of alerted.slice(0, MAX_ALERTED_MESSAGES)) {
        byConnection.set(integrationId, [...(byConnection.get(integrationId) ?? []), messageId]);
      }
      const messages: SchoolMessage[] = [];
      let unaligned = 0;
      let readAny = false;
      let unread: string | null = null;
      for (const [integrationId, messageIds] of byConnection) {
        if (!(await ports.readable(familyId, integrationId))) continue;
        const token = await ports.accessToken(integrationId);
        if (token === null) {
          unread = 'token_unavailable';
          continue;
        }
        for (const messageId of messageIds) {
          let headers: MessageHeaders | null;
          try {
            headers = await ports.headers(messageId, token);
          } catch (err) {
            unread = `google_failed:${failureName(err)}`;
            break;
          }
          if (headers === null) continue;
          readAny = true;
          const sender = alignedSenderHost(headers);
          if (sender.status === 'aligned') {
            messages.push({ integrationId, messageId, host: sender.host });
          } else {
            unaligned += 1;
          }
        }
      }
      if (readAny) return { status: 'read', messages, unaligned };
      if (unread !== null) return { status: 'unread', reason: unread };
      return { status: 'no_mail' };
    },
    async text(familyId, { integrationId, messageId }) {
      if (!(await ports.readable(familyId, integrationId))) {
        return { status: 'unread', reason: 'connection_unreadable' };
      }
      const token = await ports.accessToken(integrationId);
      if (token === null) return { status: 'unread', reason: 'token_unavailable' };
      try {
        return { status: 'read', text: await ports.body(messageId, token) };
      } catch (err) {
        return { status: 'unread', reason: `google_failed:${failureName(err)}` };
      }
    },
  };
}

export class GmailHeaderError extends Error {
  constructor(readonly status: number) {
    super(`gmail answered HTTP ${status}`);
    this.name = 'GmailHeaderError';
  }
}

const NOT_FOUND = 404;

export function productionSchoolMailPorts(
  database: Database,
  googleFetch: GoogleFetch = googleGetFetch,
): SchoolMailPorts {
  const offers = schema.emailAlertOffers;
  const verdicts = schema.kidRelevanceVerdicts;
  return {
    alertedMail: async (familyId) =>
      database
        .select({ integrationId: offers.integrationId, messageId: offers.messageId })
        .from(offers)
        .where(
          and(
            eq(offers.familyId, familyId),
            notExists(
              database
                .select({ id: verdicts.id })
                .from(verdicts)
                .where(
                  and(
                    eq(verdicts.familyId, offers.familyId),
                    eq(verdicts.source, 'gmail'),
                    eq(verdicts.integrationId, offers.integrationId),
                    eq(verdicts.itemKey, offers.messageId),
                    or(
                      eq(verdicts.verdict, 'adult'),
                      eq(verdicts.verdict, 'unsure'),
                      eq(verdicts.teen, true),
                    ),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(offers.createdAt))
        .limit(MAX_ALERTED_MESSAGES),
    readable: async (familyId, integrationId) => {
      const [row] = await database
        .select({ scopes: schema.integrations.scopes })
        .from(schema.integrations)
        .where(
          and(
            eq(schema.integrations.id, integrationId),
            eq(schema.integrations.familyId, familyId),
            eq(schema.integrations.provider, 'gmail'),
            eq(schema.integrations.status, 'active'),
          ),
        )
        .limit(1);
      return row !== undefined && CONNECTOR_SCOPES.gmail.every((s) => row.scopes.includes(s));
    },
    accessToken: (integrationId) => integrationAccessToken(database, integrationId),
    headers: async (messageId, accessToken) => {
      const res = await googleFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Authentication-Results`,
        accessToken,
      );
      if (res.status === NOT_FOUND) return null;
      if (!res.ok) throw new GmailHeaderError(res.status);
      const data = (await res.json()) as {
        payload?: { headers?: Array<{ name?: string; value?: string }> };
      };
      return (data.payload?.headers ?? []).flatMap((h) =>
        typeof h.name === 'string' && typeof h.value === 'string'
          ? [{ name: h.name, value: h.value }]
          : [],
      );
    },
    body: (messageId, accessToken) =>
      fetchGmailMessageBody(encodeURIComponent(messageId), accessToken, googleFetch),
  };
}
