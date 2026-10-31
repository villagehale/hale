import type { ReactNode } from 'react';
import { SIGNUP_TEST_PROVIDER } from '~/lib/signup/test-form';

/** Fake municipal rec chrome. Not a Hale surface. */
export function HarborShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: '100vh',
        margin: 0,
        fontFamily: 'Georgia, serif',
        background: '#f4f1ea',
        color: '#1c1c1c',
      }}
    >
      <header
        style={{
          background: '#0b3d2e',
          color: '#f4f1ea',
          padding: '16px 24px',
        }}
      >
        <p style={{ margin: 0, letterSpacing: '0.08em', fontSize: 12 }}>{SIGNUP_TEST_PROVIDER}</p>
        <h1 style={{ margin: '4px 0 0', fontSize: 22, fontWeight: 500 }}>{title}</h1>
      </header>
      <main style={{ maxWidth: 480, margin: '32px auto', padding: '0 16px' }}>{children}</main>
    </div>
  );
}

export function HarborField({
  label,
  name,
  type = 'text',
  required = true,
  autoComplete,
  children,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  children?: ReactNode;
}) {
  const id = `harbor-${name}`;
  return (
    <div style={{ marginBottom: 16 }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: 6 }}>
        {label}
      </label>
      {children ?? (
        <input
          id={id}
          name={name}
          type={type}
          required={required}
          autoComplete={autoComplete}
          style={{ width: '100%', padding: '8px 10px', fontSize: 16 }}
        />
      )}
    </div>
  );
}

export function HarborButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="submit"
      style={{
        background: '#0b3d2e',
        color: '#f4f1ea',
        border: 0,
        padding: '10px 18px',
        fontSize: 16,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
