import { rushSignal } from './forms/rush';
import type { PageControl, PageSnapshot } from './types';

/**
 * What the page itself returns. Rush classification is applied afterwards in
 * this process (`rawSnapshotToPage`), not inside the browser.
 */
export interface RawPageSnapshot {
  href: string;
  controls: PageControl[];
  priceCents: number[];
  captcha: boolean;
  confirmed: boolean;
  formText: string;
  waitingRoom: boolean;
  submitLabel: string;
  bodyText: string;
}

/**
 * Runs inside the page. No closures: Playwright and the sandbox hands script
 * both send this function's source, and nothing else, into the page.
 */
export function collectPageSnapshot(): RawPageSnapshot {
  const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const controls = Array.from(document.querySelectorAll('input, select, textarea')).map((node) => {
    const el = node as HTMLInputElement;
    const explicit = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const label = text(explicit?.textContent ?? el.closest('label')?.textContent);
    const options =
      el instanceof HTMLSelectElement
        ? Array.from(el.options)
            .filter((option) => option.value.length > 0)
            .map((option) => ({
              value: option.value,
              label: text(option.label),
              disabled: option.disabled,
            }))
        : [];
    return {
      name: el.name || '',
      type: (el.getAttribute('type') || el.tagName).toLowerCase(),
      required: el.required,
      label,
      autocomplete: el.getAttribute('autocomplete'),
      options,
    };
  });
  const marked = document.querySelector('[data-price-cents]')?.getAttribute('data-price-cents');
  const fromAttr = marked && /^\d+$/.test(marked) ? [Number(marked)] : [];
  const fromText = Array.from(
    (document.body?.innerText ?? '').matchAll(/\$\s*(\d+)(?:\.(\d{2}))?/g),
  ).map((match) => Number(match[1]) * 100 + (match[2] ? Number(match[2]) : 0));
  const captcha =
    document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, [data-sitekey]',
    ) !== null;
  const formText = Array.from(document.querySelectorAll('form'))
    .map((form) => text(form.innerText))
    .join('\n')
    .slice(0, 4000);
  const waitingRoom =
    document.querySelector(
      'iframe[src*="queue-it"], iframe[src*="queueit"], script[src*="queue-it"], script[src*="queueit"]',
    ) !== null;
  const submit = document.querySelector('button[type="submit"], input[type="submit"]');
  const submitLabel = submit
    ? text(submit instanceof HTMLInputElement ? submit.value : submit.textContent)
    : '';
  const bodyText = text(document.body?.innerText).slice(0, 4000);
  return {
    href: location.href,
    controls,
    priceCents: Array.from(new Set([...fromAttr, ...fromText])),
    captcha,
    confirmed: document.querySelector('[data-signup-status="confirmed"]') !== null,
    formText,
    waitingRoom,
    submitLabel,
    bodyText,
  };
}

/** Backend-side reading of a raw snapshot. Rush signals are decided here. */
export function rawSnapshotToPage(raw: RawPageSnapshot): PageSnapshot {
  const signal = rushSignal(`${raw.bodyText}\n${raw.formText}`);
  return {
    href: raw.href,
    controls: raw.controls,
    priceCents: raw.priceCents,
    captcha: raw.captcha,
    confirmed: raw.confirmed,
    formText: raw.formText,
    waitingRoom: raw.waitingRoom || signal === 'waiting_room',
    residentVerification: signal === 'resident_verification',
    timedOpen: signal === 'timed_open',
    submitLabel: raw.submitLabel,
  };
}
