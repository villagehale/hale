'use client';

import { type CSSProperties, useState } from 'react';
import { LOGIN_PAGE_COPY } from '~/lib/signup/login-link/page-copy';

interface VaultProps {
  code: string;
  host: string;
  providerUrl: string;
  smsHref: string | null;
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

export function ProviderLoginVault({ code, host, providerUrl, smsHref }: VaultProps) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);

  if (saved) return <SavedScreen host={host} smsHref={smsHref} />;
  if (gone) return <GoneScreen />;

  return (
    <main style={page}>
      <img src="/connect/hale-logo.jpeg" alt="" style={logo} />
      <p
        style={{ letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: 12, opacity: 0.7 }}
      >
        {LOGIN_PAGE_COPY.vaultEyebrow}
      </p>
      <h1 style={{ fontSize: 28, margin: 0, fontWeight: 500 }}>{LOGIN_PAGE_COPY.vaultHeading}</h1>
      <p style={{ opacity: 0.7, margin: 0 }}>{host}</p>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 'min(420px, 100%)' }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          const data = new FormData(event.currentTarget);
          const response = await fetch(`/api/signup/l/${encodeURIComponent(code)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: String(data.get('username') ?? ''),
              password: String(data.get('password') ?? ''),
              totpSeed: String(data.get('totpSeed') ?? '') || null,
            }),
          });
          setBusy(false);
          if (!response.ok) {
            setGone(true);
            return;
          }
          setSaved(true);
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
          <input name="totpSeed" autoComplete="one-time-code" style={input} />
        </label>
        <button type="submit" disabled={busy} style={button}>
          {LOGIN_PAGE_COPY.save}
        </button>
      </form>
      <a
        href={providerUrl}
        target="_blank"
        rel="noreferrer"
        style={{ color: 'inherit', opacity: 0.75 }}
      >
        {LOGIN_PAGE_COPY.altLogin}
      </a>
      <p style={{ fontSize: 14, opacity: 0.75, maxWidth: 360 }}>{LOGIN_PAGE_COPY.lockLine}</p>
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
      <h1 style={{ margin: 0, fontSize: 32, fontWeight: 500 }}>{LOGIN_PAGE_COPY.savedHeading}</h1>
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
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500 }}>{LOGIN_PAGE_COPY.goneTitle}</h1>
      <p style={{ margin: 0, opacity: 0.75 }}>{LOGIN_PAGE_COPY.goneBody}</p>
    </main>
  );
}
