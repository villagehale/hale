import { createHash } from 'node:crypto';
import type { Browser, Page } from 'playwright-core';
import { sameProviderHttpsUrl } from './outcome';
import { loadPlaywrightCore } from './seed';

/**
 * VIL-715 · the masked confirmation a parent gets after a registration the provider
 * confirmed. The provider's page is never captured. Hale reads only whether it shows the
 * strings Hale already holds (the confirmation number, the class's name, the amount) and
 * renders those, and nothing else, onto an empty page of its own. The image stays in memory
 * and is never stored.
 */
export interface ReceiptKeep {
  confirmationNumber: string;
  className: string | null;
  /** The amount, in the form the page prints it. */
  amount: string | null;
}

export type ReceiptFailure =
  | 'card_shaped'
  | 'no_cdp'
  | 'attach_failed'
  | 'no_page'
  | 'verify_failed'
  | 'capture_failed';

export interface MaskedReceipt {
  png: Buffer;
  sha256: string;
  bytes: number;
  kept: string[];
}

export type ReceiptResult =
  | { ok: true; receipt: MaskedReceipt }
  | { ok: false; reason: ReceiptFailure };

/** A long digit run is what a card looks like. A real number that long costs the image. */
export function cardShapedNumber(value: string): boolean {
  return /\p{Nd}{13,}/u.test(value.normalize('NFKC').replace(/[\s-]/g, ''));
}

/**
 * Runs inside the provider's page and only reads it: for each string, whether the page shows
 * it. It returns booleans, so whatever a page script does here, no page content comes back.
 */
function stringsShown(strings: string[]): boolean[] {
  const shown = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
  return strings.map((value) => shown.includes(value.replace(/\s+/g, ' ')));
}

const RECEIPT_SHEET =
  '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"><div id="receipt" style="display:inline-block;padding:16px;max-width:560px;background:#fff;color:#000;font:16px/24px system-ui,sans-serif"></div></body></html>';

/** Runs inside Hale's own empty page. The strings go in as text, never as markup. */
function fillSheet(strings: string[]): void {
  const box = document.getElementById('receipt');
  for (const value of strings) {
    const line = document.createElement('div');
    line.style.overflowWrap = 'anywhere';
    line.textContent = value;
    box?.appendChild(line);
  }
}

/**
 * The image is of an empty page of Hale's holding only these strings. Nothing of the
 * provider's page is on it to mask, so no style, image or script of theirs can paint.
 */
async function renderSheet(page: Page, strings: string[]): Promise<Buffer> {
  const sheet = await page.context().newPage();
  try {
    await sheet.setContent(RECEIPT_SHEET);
    await sheet.evaluate(fillSheet, strings);
    return await sheet.locator('#receipt').screenshot({ type: 'png', animations: 'disabled' });
  } finally {
    await sheet.close().catch(() => undefined);
  }
}

/**
 * Checks which of the kept strings the provider's page shows, and renders those. A page that
 * does not show the confirmation number leaves no image.
 */
export async function renderReceipt(page: Page, keep: ReceiptKeep): Promise<ReceiptResult> {
  if (cardShapedNumber(keep.confirmationNumber)) return { ok: false, reason: 'card_shaped' };
  const strings = [
    ...new Set(
      [keep.confirmationNumber, keep.className, keep.amount].filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0 && !cardShapedNumber(value),
      ),
    ),
  ];
  try {
    const shown = await page.evaluate(stringsShown, strings);
    const kept = strings.filter((_, index) => shown[index] === true);
    if (!kept.includes(keep.confirmationNumber)) return { ok: false, reason: 'verify_failed' };
    const png = await renderSheet(page, kept);
    return {
      ok: true,
      receipt: {
        png,
        sha256: createHash('sha256').update(png).digest('hex'),
        bytes: png.byteLength,
        kept,
      },
    };
  } catch (err) {
    console.warn(
      { error: err instanceof Error ? err.name : 'unknown' },
      'signup receipt: capture failed',
    );
    return { ok: false, reason: 'capture_failed' };
  }
}

export interface ReceiptPorts {
  /** The browser's CDP address. A credential: never logged, never stored. */
  getCdpUrl: (browserId: string) => Promise<string | null>;
  /** Undefined connects with playwright-core. */
  connect?: (cdpUrl: string) => Promise<Pick<Browser, 'contexts' | 'close'>>;
}

/**
 * Attaches to the run's browser and renders the receipt from the provider's own page.
 * Disconnecting does not stop the browser: the caller's `settleBrowser` does.
 */
export async function captureMaskedReceipt(
  ports: ReceiptPorts,
  input: { browserId: string; registrationUrl: string; keep: ReceiptKeep },
): Promise<ReceiptResult> {
  if (cardShapedNumber(input.keep.confirmationNumber)) {
    return { ok: false, reason: 'card_shaped' };
  }
  let cdpUrl: string | null;
  try {
    cdpUrl = await ports.getCdpUrl(input.browserId);
  } catch {
    return { ok: false, reason: 'no_cdp' };
  }
  if (!cdpUrl) return { ok: false, reason: 'no_cdp' };
  let browser: Pick<Browser, 'contexts' | 'close'>;
  try {
    browser = ports.connect
      ? await ports.connect(cdpUrl)
      : ((await (await loadPlaywrightCore()).connectOverCDP(cdpUrl)) as unknown as Browser);
  } catch {
    return { ok: false, reason: 'attach_failed' };
  }
  try {
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => sameProviderHttpsUrl(page.url(), input.registrationUrl) !== null);
    const page = pages.at(-1);
    if (!page) return { ok: false, reason: 'no_page' };
    return await renderReceipt(page, input.keep);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
