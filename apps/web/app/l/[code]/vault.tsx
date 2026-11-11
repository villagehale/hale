'use client';

import { type CSSProperties, useState } from 'react';
import { LOGIN_PAGE_COPY } from '~/lib/signup/login-link/page-copy';

interface VaultProps {
  code: string;
  host: string;
  purpose: string | null;
  retentionDays: number;
  smsHref: string | null;
}

export type SaveOutcome = 'saved' | 'gone' | 'fix_totp' | 'fix_form' | 'retry';

/**
 * How the page reads a save. Only a spent or unknown link (404) is gone: a 400 is a
 * field to fix and a failed request is worth another try, and neither consumed the link.
 * `status` is null when the request never got an answer.
 */
export function saveOutcome(status: number | null, error: unknown): SaveOutcome {
  if (status !== null && status >= 200 && status < 300) return 'saved';
  if (status === 404) return 'gone';
  if (status === 400) return error === 'totp' ? 'fix_totp' : 'fix_form';
  return 'retry';
}

async function saveLogin(code: string, data: FormData): Promise<SaveOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/signup/l/${encodeURIComponent(code)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(data.get('username') ?? ''),
        password: String(data.get('password') ?? ''),
        totpSeed: String(data.get('totpSeed') ?? '') || null,
      }),
    });
  } catch {
    return saveOutcome(null, undefined);
  }
  const body: unknown = await response.json().catch(() => null);
  const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
  return saveOutcome(response.status, error);
}

const page: CSSProperties = {
  minHeight: '100vh',
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  background: '#111',
  color: '#f4f1ea',
  fontFamily: 'Inter, system-ui, sans-serif',
  textAlign: 'center',
  padding: 24,
};

/** The global h1 is ink on the light portal; this page is dark, so it takes the page's color. */
const heading: CSSProperties = {
  margin: 0,
  fontWeight: 500,
  color: 'inherit',
};

const logo: CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: 16,
  objectFit: 'cover',
};

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

const button: CSSProperties = {
  border: 0,
  borderRadius: 999,
  padding: '12px 20px',
  background: '#e8f5e9',
  color: '#111',
  fontWeight: 600,
  textDecoration: 'none',
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  textAlign: 'left',
  fontSize: 14,
};

const input: CSSProperties = {
  border: '1px solid #333',
  background: '#1a1a1a',
  color: 'inherit',
  borderRadius: 10,
  padding: '10px 12px',
};

const secondaryButton: CSSProperties = {
  ...button,
  background: 'transparent',
  color: 'inherit',
  border: '1px solid #444',
};

const errorText: CSSProperties = {
  margin: 0,
  color: '#ffab91',
  fontSize: 13,
  textAlign: 'left',
};

export function ProviderLoginVault({ code, host, purpose, retentionDays, smsHref }: VaultProps) {
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  if (outcome === 'saved') return <SavedScreen host={host} smsHref={smsHref} />;
  if (outcome === 'gone') return <GoneScreen />;

  const formError =
    outcome === 'fix_form'
      ? LOGIN_PAGE_COPY.formError
      : outcome === 'retry'
        ? LOGIN_PAGE_COPY.retryError
        : null;

  return (
    <main style={page}>
      <img src="/connect/hale-logo.jpeg" alt="" style={logo} />
      <h1 style={{ ...heading, fontSize: 28, maxWidth: 420 }}>{LOGIN_PAGE_COPY.heading(host)}</h1>
      {purpose ? <p style={{ opacity: 0.7, margin: 0, maxWidth: 420 }}>{purpose}</p> : null}
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 'min(420px, 100%)' }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setOutcome(await saveLogin(code, new FormData(event.currentTarget)));
          setBusy(false);
        }}
      >
        <label style={field}>
          {LOGIN_PAGE_COPY.username}
          <input name="username" autoComplete="username" required style={input} />
        </label>
        <label style={field}>
          {LOGIN_PAGE_COPY.password}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            style={input}
          />
        </label>
        <label style={field}>
          {LOGIN_PAGE_COPY.totp}
          <input
            name="totpSeed"
            autoComplete="one-time-code"
            aria-invalid={outcome === 'fix_totp'}
            aria-describedby={outcome === 'fix_totp' ? 'totp-error' : undefined}
            style={input}
          />
          {outcome === 'fix_totp' ? (
            <span id="totp-error" role="alert" style={errorText}>
              {LOGIN_PAGE_COPY.totpError}
            </span>
          ) : null}
        </label>
        {formError ? (
          <p role="alert" style={errorText}>
            {formError}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 12 }}>
          {smsHref ? (
            <a href={smsHref} style={{ ...secondaryButton, flex: 1 }}>
              {LOGIN_PAGE_COPY.notNow}
            </a>
          ) : null}
          <button type="submit" disabled={busy} style={{ ...button, flex: 1 }}>
            {LOGIN_PAGE_COPY.save}
          </button>
        </div>
      </form>
      <p style={{ fontSize: 14, opacity: 0.75, maxWidth: 360 }}>
        {LOGIN_PAGE_COPY.lockLine(host, retentionDays)}
      </p>
    </main>
  );
}

export function SavedScreen({ host, smsHref }: { host: string; smsHref: string | null }) {
  return (
    <main style={page}>
      <img src="/connect/hale-logo.jpeg" alt="" style={logo} />
      <span style={check} aria-hidden>
        ✓
      </span>
      <h1 style={{ ...heading, fontSize: 32 }}>{LOGIN_PAGE_COPY.savedHeading}</h1>
      <p style={{ margin: 0, opacity: 0.8 }}>{LOGIN_PAGE_COPY.savedLine(host)}</p>
      {smsHref ? (
        <a href={smsHref} style={button}>
          {LOGIN_PAGE_COPY.backToHale}
        </a>
      ) : null}
    </main>
  );
}

export function GoneScreen() {
  return (
    <main style={page}>
      <h1 style={{ ...heading, fontSize: 28 }}>{LOGIN_PAGE_COPY.goneTitle}</h1>
      <p style={{ margin: 0, opacity: 0.75 }}>{LOGIN_PAGE_COPY.goneBody}</p>
    </main>
  );
}
