import { type Database, schema } from '@hale/db';
import { and, desc, eq, notExists } from 'drizzle-orm';
import { googleGetFetch } from '~/lib/cron/connector-sync';
import { integrationAccessToken } from '~/lib/integrations/gmail-draft-service';
import { CONNECTOR_SCOPES } from '~/lib/integrations/google-oauth';
import type { GoogleFetch } from '~/lib/integrations/sync';
import { senderDomainOf } from './official-board';

/**
 * VIL-685 · THE SCHOOL MAIL HALE ALREADY READS, as the domains it came from.
 *
 * The mail is the email alerts Hale already sent this family (`email_alert_offers`): mail
 * from a parent's own connected Gmail that the sentinel read as about the kids and Hale
 * told them about. A 13+ child's mail writes no offer row, so it is never here (rule #1).
 * Mail since called the parent's own (the parent's "that's mine", or the kid check's
 * `adult` verdict) is not school mail either: withdrawing its offer only ends the offer's
 * answerable window, so the verdict is what leaves it out.
 * Only the From header of those messages is fetched, from a connection that is still
 * active and readable. The address is reduced to its domain in memory and never written;
 * whether that domain is a board's own site is official-board.ts's question.
 */

/** Messages read per family: the newest alerts. An infra bound, not a rule about mail. */
export const MAX_ALERTED_MESSAGES = 10;
/** Distinct domains handed on per family. */
export const MAX_SENDER_DOMAINS = 5;

export type SchoolMailDomains =
  | { status: 'read'; domains: string[] }
  /** Hale has told this family about no email it can still read. */
  | { status: 'no_mail' }
  /** Mail was there and could not be read: a token or Google failure, by name. */
  | { status: 'unread'; reason: string };

export interface SchoolMailPorts {
  /** This family's email alerts, newest first: the connection and the message id. */
  alertedMail(familyId: string): Promise<Array<{ integrationId: string; messageId: string }>>;
  /** The connection is this family's, active, and still holds the read scope. */
  readable(familyId: string, integrationId: string): Promise<boolean>;
  accessToken(integrationId: string): Promise<string | null>;
  /** The message's From header; null when the message is gone. Throws on any other failure. */
  fromHeader(messageId: string, accessToken: string): Promise<string | null>;
}

export interface SchoolMailReader {
  domains(familyId: string): Promise<SchoolMailDomains>;
}

function failureName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export function schoolMailReader(ports: SchoolMailPorts): SchoolMailReader {
  return {
    async domains(familyId) {
      const alerted = await ports.alertedMail(familyId);
      const byConnection = new Map<string, string[]>();
      for (const { integrationId, messageId } of alerted.slice(0, MAX_ALERTED_MESSAGES)) {
        byConnection.set(integrationId, [...(byConnection.get(integrationId) ?? []), messageId]);
      }
      const domains: string[] = [];
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
          let from: string | null;
          try {
            from = await ports.fromHeader(messageId, token);
          } catch (err) {
            unread = `google_failed:${failureName(err)}`;
            break;
          }
          if (from === null) continue;
          readAny = true;
          const domain = senderDomainOf(from);
          if (domain !== null && !domains.includes(domain)) domains.push(domain);
          if (domains.length === MAX_SENDER_DOMAINS) return { status: 'read', domains };
        }
      }
      if (readAny) return { status: 'read', domains };
      if (unread !== null) return { status: 'unread', reason: unread };
      return { status: 'no_mail' };
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
                    eq(verdicts.verdict, 'adult'),
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
    fromHeader: async (messageId, accessToken) => {
      const res = await googleFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From`,
        accessToken,
      );
      if (res.status === NOT_FOUND) return null;
      if (!res.ok) throw new GmailHeaderError(res.status);
      const data = (await res.json()) as {
        payload?: { headers?: Array<{ name?: string; value?: string }> };
      };
      return data.payload?.headers?.find((h) => h.name === 'From')?.value ?? null;
    },
  };
}
