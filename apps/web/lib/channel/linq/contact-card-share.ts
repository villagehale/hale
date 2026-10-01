import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { db } from '~/lib/db';

/**
 * Whether this Linq chat has already received a successful contact-card share.
 * `mark` is a no-op when the chat is already recorded.
 */
export interface ContactCardShareStore {
  has(chatId: string): Promise<boolean>;
  mark(chatId: string, at: Date): Promise<void>;
}

export interface MemoryContactCardShareStore extends ContactCardShareStore {
  clear(): void;
}

/** Process-local stand-in. Unit tests install one so a send does not open Postgres. */
export function memoryContactCardShareStore(): MemoryContactCardShareStore {
  const shared = new Set<string>();
  return {
    async has(chatId) {
      return shared.has(chatId);
    },
    async mark(chatId) {
      shared.add(chatId);
    },
    clear() {
      shared.clear();
    },
  };
}

/** Durable record. A row survives restarts; a missing row means try again. */
export function dbContactCardShareStore(database: Database): ContactCardShareStore {
  return {
    async has(chatId) {
      const rows = await database
        .select({ chatId: schema.linqContactCardShares.chatId })
        .from(schema.linqContactCardShares)
        .where(eq(schema.linqContactCardShares.chatId, chatId))
        .limit(1);
      return rows.length > 0;
    },
    async mark(chatId, at) {
      await database
        .insert(schema.linqContactCardShares)
        .values({ chatId, sharedAt: at })
        .onConflictDoNothing({ target: schema.linqContactCardShares.chatId });
    },
  };
}

let installed: ContactCardShareStore | undefined;

/** Tests install a store here. Production leaves this unset and uses the database. */
export function installLinqContactCardShareStore(store: ContactCardShareStore | undefined): void {
  installed = store;
}

export function resolveContactCardShareStore(
  explicit?: ContactCardShareStore,
): ContactCardShareStore {
  return explicit ?? installed ?? dbContactCardShareStore(db());
}
