// config.ts allows a missing DATABASE_URL at import (Preview web builds load
// the worker with no URL). The dummy stays so a test that opens the pool has
// a stable non-server value instead of taking the unconfigured branch.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV ??= 'test';
