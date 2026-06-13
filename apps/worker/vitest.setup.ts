// The consumer module transitively imports config.ts, which validates env at
// load time (DATABASE_URL is required). Provide a dummy value so importing the
// unit-under-test doesn't require a real database connection.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV ??= 'test';
