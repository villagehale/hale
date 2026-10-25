import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Browser Use watch (0177). Family-agnostic ops data: provider pages Hale re-reads on
 * its own cron for schedules, openings and waitlists. No family_id, no PII.
 */

/** One Browser Use V4 workspace per provider host. It holds the provider's saved,
 * rerunnable script; `script_saved_at` is null until a run reports the script saved. */
export const providerWatchWorkspaces = pgTable(
  'provider_watch_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerHost: text('provider_host').notNull(),
    browserUseWorkspaceId: text('browser_use_workspace_id').notNull(),
    scriptSavedAt: timestamp('script_saved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hostIdx: uniqueIndex('provider_watch_workspaces_host_idx').on(table.providerHost),
  }),
);

export type ProviderWatchKind = 'schedule' | 'openings' | 'waitlist';

/** A provider page to re-read. Seeded by ops; the sweep moves `next_run_at`. */
export const providerWatchTargets = pgTable(
  'provider_watch_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerHost: text('provider_host').notNull(),
    sourceUrl: text('source_url').notNull(),
    kind: text('kind').$type<ProviderWatchKind>().notNull(),
    intervalMinutes: integer('interval_minutes').notNull().default(360),
    /** Residential proxy ($5/GB) only where a provider blocks direct traffic. */
    useProxy: boolean('use_proxy').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    urlKindIdx: uniqueIndex('provider_watch_targets_url_kind_idx').on(table.sourceUrl, table.kind),
    dueIdx: index('provider_watch_targets_due_idx').on(table.enabled, table.nextRunAt),
  }),
);

export type ProviderWatchOutcome = 'read' | 'unreadable' | 'failed';

/** What one run read. Append-only; `cost_usd` is the session's full recorded cost
 * when Browser Use reported it, else the run's model cost. */
export const providerWatchReadings = pgTable(
  'provider_watch_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => providerWatchTargets.id, { onDelete: 'cascade' }),
    providerHost: text('provider_host').notNull(),
    outcome: text('outcome').$type<ProviderWatchOutcome>().notNull(),
    runId: text('run_id'),
    sessionId: text('session_id'),
    reading: jsonb('reading').$type<Record<string, unknown> | null>(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }).notNull().default('0'),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    hostReadIdx: index('provider_watch_readings_host_read_idx').on(
      table.providerHost,
      table.readAt,
    ),
    readIdx: index('provider_watch_readings_read_idx').on(table.readAt),
  }),
);

export type ProviderWatchTarget = typeof providerWatchTargets.$inferSelect;
export type ProviderWatchReading = typeof providerWatchReadings.$inferSelect;
