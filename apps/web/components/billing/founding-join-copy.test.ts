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

async function renderAlreadyPaidScreen(): Promise<HTMLElement> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/api/promo/join/verify')
        ? new Response(JSON.stringify({ alreadyPaid: true }), { status: 200 })
        : new Response('{}', { status: 200 }),
    ),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(FoundingJoinForm, LABELS));
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

  it('tells a number already on a paid plan to text Hale, without the old promise', async () => {
    const screen = await renderAlreadyPaidScreen();
    expect(screen.textContent).toContain('This number is already on a paid plan.');
    expect(screen.textContent).toContain('Text Hale to start.');
    expect(screen.textContent).not.toContain('will not text first');
  });
});
