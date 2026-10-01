import { afterEach } from 'vitest';
import {
  installLinqContactCardShareStore,
  memoryContactCardShareStore,
} from './lib/channel/linq/contact-card-share';

// Provide a dummy DATABASE_URL so importing modules that read env at load time
// doesn't require real infrastructure. Tests inject their own db handle.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

// The production share store is Postgres. Unit tests that send through Linq
// must not open that pool, so they remember a chat in memory and forget it
// between tests. A test that needs the table passes its own store.
const contactCardShares = memoryContactCardShareStore();
installLinqContactCardShareStore(contactCardShares);

afterEach(() => {
  contactCardShares.clear();
});
