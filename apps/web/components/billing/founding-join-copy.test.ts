/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundingJoinForm } from './founding-join-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS = { plusLabel: '$59/yr', maxLabel: '$99/yr' };
const HALE_NUMBER = '+15555550100';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const KEEP_TEXTING = 'Keep texting Hale like you do now.';
const START = 'Text Hale to start.';

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderAlreadyPaidScreen(
  verifyBody: Record<string, unknown> = { alreadyPaid: true },
  props: { smsNumber?: string; checkoutConflict?: Record<string, unknown> } = {},
): Promise<HTMLElement> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/promo/join/verify')) {
        return new Response(JSON.stringify(verifyBody), { status: 200 });
      }
      if (url.includes('/api/promo/join/checkout') && props.checkoutConflict) {
        return new Response(JSON.stringify(props.checkoutConflict), { status: 409 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(FoundingJoinForm, { ...LABELS, smsNumber: props.smsNumber }));
  });
  await act(async () => {
    setInputValue(container.querySelector('#founding-phone') as HTMLInputElement, '5555551234');
  });
  await act(async () => {
    (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
  });
  await act(async () => {
    setInputValue(container.querySelector('#founding-code') as HTMLInputElement, '123456');
  });
  await act(async () => {
    (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
  });
  return container;
}

describe('/founding join copy', () => {
  it('drops the old promise from the join lede and keeps the prices and the refund line', () => {
    const html = renderToStaticMarkup(createElement(FoundingJoinForm, LABELS));
    expect(html).not.toContain('will not text first');
    expect(html).toContain(
      'Plus $59/yr or Max $99/yr, locked for life. We’ll text you a code, then Stripe takes the payment. Full refund anytime.</p>',
    );
  });

  it('tells a paid number with no thread to start, with the hello, and no old promise', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    const screen = await renderAlreadyPaidScreen({ alreadyPaid: true }, { smsNumber: HALE_NUMBER });
    expect(screen.textContent).toContain('This number is already on a paid plan.');
    expect(screen.textContent).toContain(START);
    expect(screen.textContent).not.toContain(KEEP_TEXTING);
    expect(screen.textContent).not.toContain('will not text first');
    expect(screen.querySelector('a')?.getAttribute('href')).toBe(
      `sms:${HALE_NUMBER}&body=Hey%20Hale%2C%20what%27s%20going%20on%3F`,
    );
  });

  it('tells a parent who already texts Hale to keep going, with an empty composer', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    const screen = await renderAlreadyPaidScreen(
      { alreadyPaid: true, hasThread: true },
      { smsNumber: HALE_NUMBER },
    );
    expect(screen.textContent).toContain('This number is already on a paid plan.');
    expect(screen.textContent).toContain(KEEP_TEXTING);
    expect(screen.textContent).not.toContain(START);
    expect(screen.querySelector('a')?.getAttribute('href')).toBe(`sms:${HALE_NUMBER}`);
  });

  it('claims neither line when the thread read failed, and opens an empty composer', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    const screen = await renderAlreadyPaidScreen(
      { alreadyPaid: true, hasThread: null },
      { smsNumber: HALE_NUMBER },
    );
    expect(screen.textContent).toContain('This number is already on a paid plan.');
    expect(screen.textContent).not.toContain(START);
    expect(screen.textContent).not.toContain(KEEP_TEXTING);
    expect(screen.querySelector('a')?.getAttribute('href')).toBe(`sms:${HALE_NUMBER}`);
  });

  it('leaves the door off for an unread thread on a device that cannot open it', async () => {
    vi.stubGlobal('navigator', { userAgent: WINDOWS });
    const screen = await renderAlreadyPaidScreen(
      { alreadyPaid: true, hasThread: null },
      { smsNumber: HALE_NUMBER },
    );
    expect(screen.textContent).not.toContain(START);
    expect(screen.querySelector('a')).toBeNull();
  });

  it('leaves the door off for that parent on a device that cannot open their thread', async () => {
    vi.stubGlobal('navigator', { userAgent: WINDOWS });
    const screen = await renderAlreadyPaidScreen(
      { alreadyPaid: true, hasThread: true },
      { smsNumber: HALE_NUMBER },
    );
    expect(screen.textContent).toContain(KEEP_TEXTING);
    expect(screen.querySelector('a')).toBeNull();
  });

  it('reads the same answer from a checkout that finds the number already paid', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    const screen = await renderAlreadyPaidScreen(
      { alreadyPaid: false },
      {
        smsNumber: HALE_NUMBER,
        checkoutConflict: { error: 'already_paid', hasThread: true },
      },
    );
    const plus = [...screen.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Continue · Plus'),
    );
    expect(plus).toBeTruthy();
    await act(async () => {
      plus?.click();
    });
    expect(screen.textContent).toContain('This number is already on a paid plan.');
    expect(screen.textContent).toContain(KEEP_TEXTING);
    expect(screen.querySelector('a')?.getAttribute('href')).toBe(`sms:${HALE_NUMBER}`);
  });
});
