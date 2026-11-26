'use client';

import { type FormEvent, type ReactNode, useState } from 'react';
import { TextDoor } from '~/components/redesign/text-door';
import type { Locale } from '~/i18n/routing';

export type PricingVerifyCopy = {
  memberPlus: string;
  memberMax: string;
  welcomePlus: string;
  welcomeMax: string;
  priceLocked: string;
  verifyPrompt: string;
  sayHi: string;
  inPlus: string;
  inMax: string;
  knowsTitle: string;
  knowsLine: string;
  findsTitle: string;
  findsLine: string;
  chatTitle: string;
  chatLine: string;
  spotTitle: string;
  spotLine: string;
  maxEverything: string;
  maxLimits: string;
  maxSupport: string;
  refund: string;
  codeSent: string;
  codeHint: string;
  phoneLabel: string;
  codeLabel: string;
  resend: string;
  editNumber: string;
  saveNumber: string;
  wrongCode: string;
  expired: string;
  locked: string;
  limited: string;
  cooldown: string;
  notSent: string;
  phoneInvalid: string;
  confirm: string;
  paymentEnded: string;
  alreadyOnPlan: string;
  textHale: string;
};

const copyStyle = { fontFamily: 'var(--font-ui)', color: 'var(--navy)' } as const;

type CodeResponse = {
  status?: string;
  phone?: string | null;
  direct?: boolean;
  bound?: boolean;
};

function messageFor(status: string, copy: PricingVerifyCopy): string {
  switch (status) {
    case 'sent':
      return copy.codeSent;
    case 'cooldown':
      return copy.cooldown;
    case 'send_limited':
    case 'attempts_limited':
      return copy.limited;
    case 'invalid_phone':
      return copy.phoneInvalid;
    case 'payment_ended':
      return copy.paymentEnded;
    case 'wrong_code':
      return copy.wrongCode;
    case 'expired':
      return copy.expired;
    case 'locked':
      return copy.locked;
    default:
      return copy.notSent;
  }
}

function Check() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function Benefit({ title, line }: { title: string; line?: string }) {
  return (
    <li>
      <Check />
      <span style={copyStyle}>
        <b style={{ display: 'block' }}>{title}</b>
        {line ? <span style={{ fontWeight: 400 }}>{line}</span> : null}
      </span>
    </li>
  );
}

function RefundLine({ template, email }: { template: string; email: string }) {
  const token = '{email}';
  const at = template.indexOf(token);
  if (at < 0) {
    return (
      <p className="hs-p" style={{ ...copyStyle, marginTop: 'var(--s5)' }}>
        {template}
      </p>
    );
  }
  return (
    <p className="hs-p" style={{ ...copyStyle, marginTop: 'var(--s5)' }}>
      {template.slice(0, at)}
      <a href={`mailto:${email}`}>{email}</a>
      {template.slice(at + token.length)}
    </p>
  );
}

/**
 * The paid session is confirmed. Text Hale waits until the code matches the
 * number Hale will bind. Resend and a corrected number both ask for a new code.
 */
export function PricingCheckoutVerify({
  sessionId,
  initialPhone,
  initialStatus,
  initialBound = false,
  tier,
  locale,
  smsNumber,
  prefill,
  refundEmail,
  copy,
}: {
  sessionId: string;
  initialPhone: string | null;
  initialStatus: string;
  initialBound?: boolean;
  tier: 'plus' | 'family' | null;
  locale: Locale;
  smsNumber: string;
  prefill: string;
  refundEmail: string;
  copy: PricingVerifyCopy;
}) {
  const [phone, setPhone] = useState(initialPhone ?? '');
  const [editing, setEditing] = useState(initialStatus === 'invalid_phone' || !initialPhone);
  const [code, setCode] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [note, setNote] = useState(messageFor(initialStatus, copy));
  const [bound, setBound] = useState(initialBound);
  const [onPlan, setOnPlan] = useState(false);
  const [pending, setPending] = useState(false);
  const max = tier === 'family';

  async function post(path: string, body: Record<string, unknown>): Promise<CodeResponse | null> {
    setPending(true);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as CodeResponse;
    } catch {
      return null;
    } finally {
      setPending(false);
    }
  }

  async function send(nextPhone: string | null, resend: boolean) {
    const result = await post('/api/checkout/code', {
      sessionId,
      resend,
      ...(nextPhone ? { phone: nextPhone } : {}),
    });
    const next = result?.status ?? 'send_failed';
    if (typeof result?.phone === 'string' && result.phone) setPhone(result.phone);
    if (result?.bound) {
      setBound(true);
      return;
    }
    setStatus(next);
    setNote(messageFor(next, copy));
    if (next === 'sent') setEditing(false);
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    const result = await post('/api/checkout/verify', { sessionId, code });
    const next = result?.status ?? 'no_pending';
    if (next === 'verified' || next === 'already_bound' || next === 'already_subscribed') {
      if (next === 'already_subscribed') setOnPlan(true);
      setBound(true);
      return;
    }
    setStatus(next);
    setNote(messageFor(next, copy));
  }

  const card = (middle: ReactNode) => (
    <div className="sp-grid">
      <div className="hs-glass sp-card sp-aside">
        <p className="hs-eyebrow">{max ? copy.memberMax : copy.memberPlus}</p>
        <h1 className="hs-h2" style={copyStyle}>
          {max ? copy.welcomeMax : copy.welcomePlus}
        </h1>
        <p className="hs-p" style={copyStyle}>
          {copy.priceLocked}
        </p>
        {middle}
        <h2 className="hs-h3" style={{ ...copyStyle, marginTop: 'var(--s5)' }}>
          {max ? copy.inMax : copy.inPlus}
        </h2>
        <ul className="hs-checks" style={{ marginTop: 'var(--s4)' }}>
          {max ? (
            <>
              <Benefit title={copy.maxEverything} />
              <Benefit title={copy.maxLimits} />
              <Benefit title={copy.maxSupport} />
            </>
          ) : (
            <>
              <Benefit title={copy.knowsTitle} line={copy.knowsLine} />
              <Benefit title={copy.findsTitle} line={copy.findsLine} />
              <Benefit title={copy.chatTitle} line={copy.chatLine} />
              <Benefit title={copy.spotTitle} line={copy.spotLine} />
            </>
          )}
        </ul>
        <RefundLine template={copy.refund} email={refundEmail} />
      </div>
    </div>
  );

  if (bound) {
    return card(
      <>
        {onPlan ? (
          <p className="hs-p" style={copyStyle}>
            {copy.alreadyOnPlan}
          </p>
        ) : null}
        <div className="sp-cta">
          <TextDoor
            className="btn btn-hero"
            placement="checkout_success"
            locale={locale}
            smsNumber={smsNumber}
            prefill={prefill}
            mode="sms"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 2.75c4.28 0 7.75 2.86 7.75 6.38 0 3.53-3.47 6.38-7.75 6.38-.86 0-1.69-.11-2.46-.33L3.6 16.9a.4.4 0 0 1-.56-.46l.83-2.97C2.88 12.36 2.25 10.8 2.25 9.13c0-3.52 3.47-6.38 7.75-6.38Z" />
            </svg>
            {copy.textHale}
          </TextDoor>
        </div>
        <p
          className="hs-meta"
          style={{ ...copyStyle, marginTop: 'var(--s3)', textAlign: 'center' }}
        >
          {copy.sayHi}
        </p>
      </>,
    );
  }

  return card(
    <div className="hs-card sp-panel" style={{ marginTop: 'var(--s5)' }}>
      <p className="hs-p" style={{ ...copyStyle, marginTop: 0 }}>
        {copy.verifyPrompt}
      </p>
      <p className="hs-p" style={copyStyle}>
        {note}
      </p>
      {status === 'sent' ? (
        <p className="hs-p" style={copyStyle}>
          {copy.codeHint}
        </p>
      ) : null}
      <form onSubmit={confirm}>
        <div className="sp-verify" style={{ margin: 'var(--s4) auto 0', width: '100%' }}>
          <label htmlFor="pricing-phone">
            {copy.phoneLabel}
            <input
              id="pricing-phone"
              className="ph-mask"
              name="phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              readOnly={!editing}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          {editing ? null : (
            <label htmlFor="pricing-code">
              {copy.codeLabel}
              <input
                id="pricing-code"
                className="ph-mask"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
          )}
        </div>
        <div className="sp-cta" style={{ flexDirection: 'column' }}>
          {editing ? (
            <button
              className="btn btn-hero"
              type="button"
              disabled={pending || phone.trim() === ''}
              onClick={() => send(phone, true)}
            >
              {copy.saveNumber}
            </button>
          ) : (
            <button className="btn btn-hero" type="submit" disabled={pending || code.trim() === ''}>
              {copy.confirm}
            </button>
          )}
          {editing ? null : (
            <div className="sp-cta" style={{ marginTop: 0, width: '100%' }}>
              <button
                className="rd-textlink"
                type="button"
                disabled={pending}
                onClick={() => send(null, true)}
              >
                <span>{copy.resend}</span>
              </button>
              <button className="rd-textlink" type="button" onClick={() => setEditing(true)}>
                <span>{copy.editNumber}</span>
              </button>
            </div>
          )}
        </div>
      </form>
    </div>,
  );
}
