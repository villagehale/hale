'use client';

import { type FormEvent, useState } from 'react';
import { TextDoor } from '~/components/redesign/text-door';
import type { Locale } from '~/i18n/routing';

export type PricingVerifyCopy = {
  heading: string;
  plan: string | null;
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
  lede: string;
  textHale: string;
};

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

/**
 * The paid session is confirmed. Text Hale waits until the code matches the
 * number Hale will bind. Resend and a corrected number both ask for a new code.
 */
export function PricingCheckoutVerify({
  sessionId,
  initialPhone,
  initialStatus,
  initialBound = false,
  locale,
  smsNumber,
  prefill,
  copy,
}: {
  sessionId: string;
  initialPhone: string | null;
  initialStatus: string;
  initialBound?: boolean;
  locale: Locale;
  smsNumber: string;
  prefill: string;
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

  if (bound) {
    return (
      <div className="sp-grid">
        <div className="sp-copy sp-checkout">
          <h1 className="sp-h1">{copy.heading}</h1>
          {copy.plan ? <p className="sp-lede">{copy.plan}</p> : null}
          <p className="sp-lede">{onPlan ? copy.alreadyOnPlan : copy.lede}</p>
          <div className="sp-cta">
            <TextDoor
              className="btn btn-hero"
              placement="checkout_success"
              locale={locale}
              smsNumber={smsNumber}
              prefill={prefill}
              mode="sms"
            >
              {copy.textHale}
            </TextDoor>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-grid">
      <div className="sp-copy sp-checkout">
        <h1 className="sp-h1">{copy.heading}</h1>
        {copy.plan ? <p className="sp-lede">{copy.plan}</p> : null}
        <p className="sp-lede">{note}</p>
        {status === 'sent' ? <p className="sp-lede">{copy.codeHint}</p> : null}
        <form className="sp-verify" onSubmit={confirm}>
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
            <>
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
              <div className="sp-cta">
                <button
                  className="btn btn-hero"
                  type="submit"
                  disabled={pending || code.trim() === ''}
                >
                  {copy.confirm}
                </button>
                <button
                  className="sp-btn2"
                  type="button"
                  disabled={pending}
                  onClick={() => send(null, true)}
                >
                  {copy.resend}
                </button>
                <button className="sp-btn2" type="button" onClick={() => setEditing(true)}>
                  {copy.editNumber}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
