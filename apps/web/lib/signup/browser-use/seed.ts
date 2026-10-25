import type { ProviderStorageState } from './vault';

/**
 * Loads a captured provider session into a Browser Use browser over CDP, so the
 * profile it belongs to starts the signup run already logged in. Cookies and
 * local storage only. Nothing here types into a page or reads one.
 */
export interface ProviderSessionSeeder {
  seed(cdpUrl: string, state: ProviderStorageState): Promise<void>;
}

interface CdpPage {
  goto(url: string): Promise<unknown>;
  evaluate<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  close(): Promise<void>;
}

interface CdpContext {
  addCookies(cookies: ProviderStorageState['cookies']): Promise<void>;
  newPage(): Promise<CdpPage>;
}

interface CdpBrowser {
  contexts(): CdpContext[];
  close(): Promise<void>;
}

export interface CdpConnector {
  connectOverCDP(endpoint: string): Promise<CdpBrowser>;
}

export function cdpSessionSeeder(connector: CdpConnector): ProviderSessionSeeder {
  return {
    async seed(cdpUrl, state) {
      const browser = await connector.connectOverCDP(cdpUrl);
      try {
        const context = browser.contexts()[0];
        if (!context) throw new Error('browser use browser has no default context');
        if (state.cookies.length > 0) await context.addCookies(state.cookies);
        for (const origin of state.origins) {
          if (origin.localStorage.length === 0) continue;
          const page = await context.newPage();
          try {
            await page.goto(origin.origin);
            await page.evaluate((entries: { name: string; value: string }[]) => {
              for (const entry of entries) window.localStorage.setItem(entry.name, entry.value);
            }, origin.localStorage);
          } finally {
            await page.close();
          }
        }
      } finally {
        await browser.close();
      }
    },
  };
}

export type CdpConnectorLoader = () => Promise<CdpConnector>;

/**
 * `playwright-core` is a runtime dependency because attaching over CDP needs no
 * browser binary, so it runs inside a Vercel function. apps/web is ESM, so a
 * bare `require` is undefined there; this loads it with a dynamic `import()`,
 * which Next's file tracing follows for a server-external package.
 */
export const loadPlaywrightCore: CdpConnectorLoader = async () => {
  const mod = (await import('playwright-core')) as {
    chromium?: CdpConnector;
    default?: { chromium?: CdpConnector };
  };
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error('playwright-core has no chromium export');
  return chromium;
};

/**
 * Loads the CDP client on first use. A load failure surfaces from `seed`, which
 * the engine reports as `seed_failed` for that run instead of every new profile
 * silently becoming `seed_unavailable`.
 */
export function playwrightSessionSeeder(
  load: CdpConnectorLoader = loadPlaywrightCore,
): ProviderSessionSeeder {
  let connector: Promise<CdpConnector> | null = null;
  return {
    async seed(cdpUrl, state) {
      connector ??= load().catch((error: unknown) => {
        connector = null;
        throw error;
      });
      await cdpSessionSeeder(await connector).seed(cdpUrl, state);
    },
  };
}
