/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_CONNECTION_ERROR } from '~/lib/auth/claim-phone-copy';
import { FoundingJoinForm } from './founding-join-form';
import { FreeJoinCard } from './free-join-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('FoundingJoinForm', () => {
  it('shows Plus and Max yearly prices with a plain $ and a full refund anytime', () => {
    const html = renderToStaticMarkup(
      createElement(FoundingJoinForm, { plusLabel: '$59/yr', maxLabel: '$99/yr' }),
    );
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
    expect(html).toContain('Plus');
    expect(html).toContain('Max');
    expect(html).toContain('Full refund anytime');
    expect(html).not.toContain('C$');
    expect(html).not.toMatch(/\bCAD\b/);
    expect(html).not.toContain('ask for a refund');
  });
});

describe('FreeJoinCard', () => {
  it('keeps the free promise next to founding join', () => {
    const html = renderToStaticMarkup(createElement(FreeJoinCard));
    expect(html).toContain('Free');
    expect(html).toContain('Everything Hale does is free for you.');
    expect(html).not.toMatch(/\$\d/);
  });
});

describe('/founding three-option pair', () => {
  it('renders Free plus Plus and Max annual, with no monthly or list annual', () => {
    const html = renderToStaticMarkup(
      createElement('div', null, [
        createElement(FreeJoinCard, { key: 'free' }),
        createElement(FoundingJoinForm, {
          key: 'founding',
          plusLabel: '$59/yr',
          maxLabel: '$99/yr',
        }),
      ]),
    );
    expect(html).toContain('Free');
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
    expect(html).toContain('Join Hale');
    expect(html).toContain('Biggest sale of the year');
    expect(html).not.toMatch(/founding famil/i);
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('$159/yr');
    expect(html).not.toContain('Continue ·');
  });
});

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('FoundingJoinForm for a number already on a paid plan', () => {
  it('keeps the sale eyebrow and drops the founding one', async () => {
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
      root?.render(createElement(FoundingJoinForm, { plusLabel: '$59/yr', maxLabel: '$99/yr' }));
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

    expect(container.textContent).toContain('This number is already on a paid plan.');
    expect(container.textContent).toContain('Biggest sale of the year');
    expect(container.textContent).not.toMatch(/founding/i);
  });
});

describe('FoundingJoinForm checkout errors', () => {
  it('shows a connection error when Plus checkout fetch rejects', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/promo/join/request')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/api/promo/join/verify')) {
        return new Response(JSON.stringify({ alreadyPaid: false }), { status: 200 });
      }
      throw new Error('network');
    });
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(FoundingJoinForm, { plusLabel: '$59/yr', maxLabel: '$99/yr' }));
    });

    const phone = container.querySelector('#founding-phone') as HTMLInputElement;
    await act(async () => {
      setInputValue(phone, '5555551234');
    });
    await act(async () => {
      (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });

    const code = container.querySelector('#founding-code') as HTMLInputElement;
    expect(code).toBeTruthy();
    await act(async () => {
      setInputValue(code, '123456');
    });
    await act(async () => {
      (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });

    const plus = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Continue · Plus'),
    );
    expect(plus).toBeTruthy();
    await act(async () => {
      plus?.click();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(CLAIM_CONNECTION_ERROR);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/promo/join/checkout'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
