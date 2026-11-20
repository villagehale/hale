'use client';

import { type CSSProperties, useState } from 'react';
import { POSTHOG_MASK_INPUT_SELECTOR } from '~/lib/analytics/posthog-provider';
import { TAKEOVER_PAGE_COPY } from '~/lib/signup/login-link/page-copy';
import { GoneScreen } from './vault';

interface TakeoverProps {
  code: string;
  host: string;
  /** The card's title, as the model wrote it in the parent's language. Null: the bare host. */
  title: string | null;
  description: string | null;
  smsHref: string | null;
}

/**
 * How the page reads an answer. Only a spent, expired or unknown card (404) is gone; any
 * other failure is worth another tap, and none of them spent the card. `status` is null when
 * the request never got an answer.
 */
export type TakeoverAnswer = 'ok' | 'gone' | 'retry';

export function takeoverAnswer(status: number | null): TakeoverAnswer {
  if (status !== null && status >= 200 && status < 300) return 'ok';
  if (status === 404) return 'gone';
  return 'retry';
}

/**
 * VIL-718 · asks for the live view with a POST, so the browser link never sits in the page a
 * link preview fetches. The answer is the live view on Browser Use's own host, or nothing.
 */
async function openBrowser(code: string): Promise<{ answer: TakeoverAnswer; url: string | null }> {
  let response: Response;
  try {
    response = await fetch(`/api/signup/l/${encodeURIComponent(code)}/live`, {
      method: 'POST',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    return { answer: 'retry', url: null };
  }
  const answer = takeoverAnswer(response.status);
  if (answer !== 'ok') return { answer, url: null };
  const body: unknown = await response.json().catch(() => null);
  const url =
    body &&
    typeof body === 'object' &&
    'liveViewUrl' in body &&
    typeof body.liveViewUrl === 'string'
      ? body.liveViewUrl
      : null;
  return url ? { answer, url } : { answer: 'retry', url: null };
}

async function finish(code: string): Promise<TakeoverAnswer> {
  try {
    const response = await fetch(`/api/signup/l/${encodeURIComponent(code)}/done`, {
      method: 'POST',
      cache: 'no-store',
    });
    return takeoverAnswer(response.status);
  } catch {
    return 'retry';
  }
}

const page: CSSProperties = {
  minHeight: '100vh',
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 16,
  background: '#111',
  color: '#f4f1ea',
  fontFamily: 'Inter, system-ui, sans-serif',
  textAlign: 'center',
  padding: 24,
};

const heading: CSSProperties = { margin: 0, fontWeight: 500, color: 'inherit' };

const logo: CSSProperties = { width: 56, height: 56, borderRadius: 14, objectFit: 'cover' };

const button: CSSProperties = {
  border: 0,
  borderRadius: 999,
  padding: '12px 20px',
  background: '#e8f5e9',
  color: '#111',
  fontWeight: 600,
  textDecoration: 'none',
  cursor: 'pointer',
};

const secondaryButton: CSSProperties = {
  ...button,
  background: 'transparent',
  color: 'inherit',
  border: '1px solid #444',
};

const frame: CSSProperties = {
  width: 'min(1024px, 100%)',
  height: '70vh',
  border: '1px solid #333',
  borderRadius: 12,
  background: '#000',
};

const errorText: CSSProperties = { margin: 0, color: '#ffab91', fontSize: 13 };

const check: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 999,
  background: '#2e7d32',
  color: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 28,
};

export function TakeoverScreen({ code, host, title, description, smsHref }: TakeoverProps) {
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'opening' | 'finishing' | 'done' | 'gone'>('idle');
  const [error, setError] = useState<string | null>(null);

  if (state === 'gone') return <GoneScreen />;
  if (state === 'done') return <TakeoverDoneScreen smsHref={smsHref} />;

  const open = async () => {
    setState('opening');
    setError(null);
    const opened = await openBrowser(code);
    if (opened.answer === 'gone') return setState('gone');
    if (!opened.url) {
      setError(TAKEOVER_PAGE_COPY.openError);
      return setState('idle');
    }
    setLiveUrl(opened.url);
    setState('idle');
  };

  const done = async () => {
    setState('finishing');
    setError(null);
    const answer = await finish(code);
    if (answer === 'ok') return setState('done');
    if (answer === 'gone') return setState('gone');
    setError(TAKEOVER_PAGE_COPY.doneError);
    setState('idle');
  };

  return (
    <main className={POSTHOG_MASK_INPUT_SELECTOR} style={page}>
      <img src="/connect/hale-logo.jpeg" alt="" style={logo} />
      <h1 style={{ ...heading, fontSize: 26, maxWidth: 520 }}>{title ?? host}</h1>
      {description ? <p style={{ opacity: 0.7, margin: 0, maxWidth: 520 }}>{description}</p> : null}
      {liveUrl ? (
        <>
          <iframe
            src={liveUrl}
            title={TAKEOVER_PAGE_COPY.frameTitle(host)}
            style={frame}
            referrerPolicy="no-referrer"
            allow="clipboard-read; clipboard-write"
          />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <a href={liveUrl} target="_blank" rel="noreferrer noopener" style={secondaryButton}>
              {TAKEOVER_PAGE_COPY.fullScreen}
            </a>
            <button type="button" onClick={done} disabled={state === 'finishing'} style={button}>
              {TAKEOVER_PAGE_COPY.done}
            </button>
          </div>
        </>
      ) : (
        <button type="button" onClick={open} disabled={state === 'opening'} style={button}>
          {state === 'opening' ? TAKEOVER_PAGE_COPY.opening : TAKEOVER_PAGE_COPY.open(host)}
        </button>
      )}
      {error ? (
        <p role="alert" style={errorText}>
          {error}
        </p>
      ) : null}
    </main>
  );
}

export function TakeoverDoneScreen({ smsHref }: { smsHref: string | null }) {
  return (
    <main style={{ ...page, justifyContent: 'center' }}>
      <img src="/connect/hale-logo.jpeg" alt="" style={logo} />
      <span style={check} aria-hidden>
        ✓
      </span>
      <h1 style={{ ...heading, fontSize: 32 }}>{TAKEOVER_PAGE_COPY.doneHeading}</h1>
      <p style={{ margin: 0, opacity: 0.8 }}>{TAKEOVER_PAGE_COPY.doneLine}</p>
      {smsHref ? (
        <a href={smsHref} style={button}>
          {TAKEOVER_PAGE_COPY.backToHale}
        </a>
      ) : null}
    </main>
  );
}
