import { createHash } from 'node:crypto';
import type { Browser, CDPSession, Page } from 'playwright-core';
import { sameProviderHttpsUrl } from './outcome';
import { loadPlaywrightCore } from './seed';

/**
 * VIL-715 · the masked confirmation a parent gets after a registration the provider
 * confirmed. Deny by default: every element on the page is hidden, then only strings Hale
 * already holds are put back: the confirmation number, the class's name and the amount as
 * the page prints it. What is painted is checked before any capture, and a page that
 * cannot be cleared leaves no image. The image stays in memory and is never stored.
 */
export interface ReceiptKeep {
  confirmationNumber: string;
  className: string | null;
  /** The amount as the page prints it. */
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

interface MaskPlaced {
  kept: string[];
  clip: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Runs inside the page. No closures: only this function's source is sent. Wraps the first
 * occurrence of each string in its own span, hides every element that does not hold one,
 * and empties the text beside them.
 */
function maskInPage(strings: string[]): MaskPlaced {
  const KEEP = 'data-hale-keep';
  const body = document.body;
  if (!body) return { kept: [], clip: null };
  const kept: string[] = [];
  for (const text of strings) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (!parent || parent.closest(`script,style,noscript,template,textarea,[${KEEP}]`)) continue;
      const at = textNode.data.indexOf(text);
      if (at < 0) continue;
      const match = textNode.splitText(at);
      match.splitText(text.length);
      const span = document.createElement('span');
      span.setAttribute(KEEP, '');
      span.textContent = text;
      match.replaceWith(span);
      kept.push(text);
      break;
    }
  }
  const spans = Array.from(document.querySelectorAll<HTMLElement>(`[${KEEP}]`));
  const holders = new Set<Element>();
  for (const span of spans) {
    for (let el = span.parentElement; el; el = el.parentElement) holders.add(el);
  }
  const set = (el: HTMLElement | SVGElement, property: string, value: string) =>
    el.style.setProperty(property, value, 'important');
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    if (el.hasAttribute(KEEP) || el.closest('head')) continue;
    if (!holders.has(el)) {
      set(el, 'display', 'none');
      continue;
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) (child as Text).data = '';
    }
    set(el, 'visibility', 'hidden');
    set(el, 'background', el === document.documentElement ? '#fff' : 'none');
    for (const [property, value] of [
      ['border', 'none'],
      ['outline', 'none'],
      ['box-shadow', 'none'],
      ['transform', 'none'],
      ['filter', 'none'],
      ['backdrop-filter', 'none'],
      ['perspective', 'none'],
      ['opacity', '1'],
      ['contain', 'none'],
      ['will-change', 'auto'],
      ['clip-path', 'none'],
      ['mask', 'none'],
      ['mix-blend-mode', 'normal'],
      ['overflow', 'visible'],
      ['zoom', '1'],
    ] as const) {
      set(el, property, value);
    }
  }
  const style = document.createElement('style');
  const any = ':is(#hale-a#hale-b#hale-c#hale-d, *)';
  style.textContent = `${any}::before,${any}::after,${any}::marker{content:none !important;display:none !important}html{color-scheme:light !important}`;
  document.documentElement.appendChild(style);
  spans.forEach((span, index) => {
    span.style.cssText = `all:initial !important;position:fixed !important;left:16px !important;top:${16 + index * 28}px !important;display:block !important;visibility:visible !important;color:#000 !important;background:#fff !important;font:16px/24px system-ui,sans-serif !important;white-space:nowrap !important;z-index:2147483647 !important;`;
  });
  if (spans.length === 0) return { kept, clip: null };
  const boxes = spans.map((span) => span.getBoundingClientRect());
  const right = Math.ceil(Math.max(...boxes.map((box) => box.right)));
  const bottom = Math.ceil(Math.max(...boxes.map((box) => box.bottom)));
  return { kept, clip: { x: 8, y: 8, width: right, height: bottom } };
}

interface LayoutSnapshot {
  documents: Array<{
    nodes: { nodeName: number[] };
    layout: { nodeIndex: number[]; styles: number[][]; text: number[] };
    textBoxes: { layoutIndex: number[]; start: number[]; length: number[] };
  }>;
  strings: string[];
}

const PAINTED_MEDIA = new Set(['IMG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED', 'SVG']);

/**
 * The layout tree is what will actually paint, and it holds what a DOM walk cannot see:
 * closed shadow roots and pseudo-element text. Every visible text box must be one kept
 * string, every kept string must be there, and nothing visible may be media.
 */
function paintsOnlyKept(snapshot: LayoutSnapshot, kept: readonly string[]): boolean {
  const { strings } = snapshot;
  const seen = new Set<string>();
  for (const doc of snapshot.documents) {
    const visible = (layoutIndex: number) => {
      const style = doc.layout.styles[layoutIndex]?.[0];
      return style === undefined || strings[style] !== 'hidden';
    };
    for (let i = 0; i < doc.layout.nodeIndex.length; i += 1) {
      const node = doc.layout.nodeIndex[i] as number;
      const name = strings[doc.nodes.nodeName[node] as number]?.toUpperCase() ?? '';
      if (PAINTED_MEDIA.has(name) && visible(i)) return false;
    }
    for (let box = 0; box < doc.textBoxes.layoutIndex.length; box += 1) {
      const layoutIndex = doc.textBoxes.layoutIndex[box] as number;
      if (!visible(layoutIndex)) continue;
      const full = strings[doc.layout.text[layoutIndex] as number] ?? '';
      const start = doc.textBoxes.start[box] as number;
      const text = full.slice(start, start + (doc.textBoxes.length[box] as number)).trim();
      if (!text) continue;
      if (!kept.includes(text)) return false;
      seen.add(text);
    }
  }
  return kept.every((text) => seen.has(text));
}

/**
 * Masks the open page and captures it. The freeze lasts as long as this CDP session, so it
 * covers the mask, the check and the capture. `freeze` and `afterMask` exist only for the
 * test's controls.
 */
export async function maskAndCapture(
  page: Page,
  keep: ReceiptKeep,
  options: { freeze?: boolean; afterMask?: () => Promise<void> } = {},
): Promise<ReceiptResult> {
  if (cardShapedNumber(keep.confirmationNumber)) return { ok: false, reason: 'card_shaped' };
  const strings = [
    ...new Set(
      [keep.confirmationNumber, keep.className, keep.amount].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    ),
  ];
  const cdp: CDPSession = await page.context().newCDPSession(page);
  try {
    if (options.freeze !== false) {
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
    }
    const placed = await page.evaluate(maskInPage, strings);
    if (!placed.clip || !placed.kept.includes(keep.confirmationNumber)) {
      return { ok: false, reason: 'verify_failed' };
    }
    await options.afterMask?.();
    const snapshot = (await cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: ['visibility'],
    })) as unknown as LayoutSnapshot;
    if (!paintsOnlyKept(snapshot, placed.kept)) return { ok: false, reason: 'verify_failed' };
    const png = await page.screenshot({
      type: 'png',
      clip: placed.clip,
      animations: 'disabled',
    });
    return {
      ok: true,
      receipt: {
        png,
        sha256: createHash('sha256').update(png).digest('hex'),
        bytes: png.byteLength,
        kept: placed.kept,
      },
    };
  } catch (err) {
    console.warn(
      { error: err instanceof Error ? err.name : 'unknown' },
      'signup receipt: capture failed',
    );
    return { ok: false, reason: 'capture_failed' };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export interface ReceiptPorts {
  /** The browser's CDP address. A credential: never logged, never stored. */
  getCdpUrl: (browserId: string) => Promise<string | null>;
  /** Undefined connects with playwright-core. */
  connect?: (cdpUrl: string) => Promise<Pick<Browser, 'contexts' | 'close'>>;
}

/**
 * Attaches to the run's browser, on the provider's own page, and masks it. Disconnecting
 * does not stop the browser: the caller's `settleBrowser` does.
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
    return await maskAndCapture(page, input.keep);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
