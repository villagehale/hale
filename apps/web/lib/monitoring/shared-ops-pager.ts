import type { OpsPager } from '~/lib/monitoring/failure-page';

/**
 * The ops pager behind the module-level shared writers. failure-page and the database
 * load on the first page, not at import: vitest.setup.ts imports those writers, and a
 * static import would load drizzle before a test file's vi.mock('drizzle-orm') applies.
 */
export const sharedOpsPager: OpsPager = {
  async page(page) {
    const [{ failurePageOpsPager }, { db }] = await Promise.all([
      import('~/lib/monitoring/failure-page'),
      import('~/lib/db'),
    ]);
    return failurePageOpsPager(db).page(page);
  },
};
