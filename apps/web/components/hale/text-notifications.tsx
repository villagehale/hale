'use client';

import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import {
  requestSmsOtpAction,
  revokeSmsChannelAction,
  verifySmsOtpAction,
} from '~/lib/channels/sms-consent-actions';
import { SMS_CONSENT_COPY } from '~/lib/channels/sms-consent-copy';
import type { LoadSmsChannelResult } from '~/lib/channels/sms-consent';

/**
 * Settings → Account → "Text notifications" (VIL-212). Enrols a parent's phone for
 * the Sunday-loop SMS: enter number → 6-digit code → CASL express consent recorded
 * on verify. Consent is per-PARENT (co-parents enrol independently). Until the SMS
 * sender is provisioned the UI shows an honest "arrives when texting launches"
 * state — never a dead form that pretends to send (rule #1). The number is only
 * ever shown masked; the raw value never reaches this component.
 */

const NOT_READY_NOTE: Record<Exclude<LoadSmsChannelResult['status'], 'ready'>, string> = {
  preview: 'Sign in to get your family’s week by text.',
  unauthenticated: 'Sign in to get your family’s week by text.',
  not_found: 'Finish setting up your family, then you can add a number.',
};

export function TextNotifications({ result }: { result: LoadSmsChannelResult }) {
  if (result.status !== 'ready') {
    return <p className="text-spruce leading-relaxed max-w-md">{NOT_READY_NOTE[result.status]}</p>;
  }
  return (
    <TextChannel
      initialEnrolled={result.channel.enrolled}
      initialMasked={result.channel.maskedPhone}
      senderConfigured={result.senderConfigured}
    />
  );
}

type Phase = 'phone' | 'code';

function TextChannel({
  initialEnrolled,
  initialMasked,
  senderConfigured,
}: {
  initialEnrolled: boolean;
  initialMasked: string | null;
  senderConfigured: boolean;
}) {
  const [enrolled, setEnrolled] = useState(initialEnrolled);
  const [masked, setMasked] = useState(initialMasked);
  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function sendCode() {
    setPending(true);
    setNote(null);
    const outcome = await requestSmsOtpAction(phone);
    setPending(false);
    switch (outcome.status) {
      case 'sent':
        setMasked(outcome.maskedPhone);
        setPhase('code');
        setNote(`We texted a 6-digit code to ${outcome.maskedPhone}.`);
        return;
      case 'invalid_phone':
        setNote('That doesn’t look like a Canadian or US number — check it and try again.');
        return;
      case 'cooldown':
        setNote('Hang on a moment before requesting another code.');
        return;
      case 'not_configured':
        setNote('Texting isn’t switched on yet — we’ll let you know when it launches.');
        return;
      case 'rate_limited':
        setNote('Too many tries just now — please wait a little and try again.');
        return;
      default:
        setNote('Couldn’t send that code just now — please try again.');
    }
  }

  async function verify() {
    setPending(true);
    setNote(null);
    const outcome = await verifySmsOtpAction(code);
    setPending(false);
    switch (outcome.status) {
      case 'verified':
        setEnrolled(true);
        setMasked(outcome.maskedPhone);
        setCode('');
        setNote(null);
        return;
      case 'wrong_code':
        setNote(
          `That code didn’t match — ${outcome.attemptsRemaining} ${
            outcome.attemptsRemaining === 1 ? 'try' : 'tries'
          } left.`,
        );
        return;
      case 'locked':
        setNote('Too many wrong tries. Request a new code to start over.');
        setPhase('phone');
        return;
      case 'expired':
      case 'no_pending':
        setNote('That code expired. Request a new one.');
        setPhase('phone');
        return;
      case 'rate_limited':
        setNote('Too many tries just now — please wait a little and try again.');
        return;
      default:
        setNote('Couldn’t verify that just now — please try again.');
    }
  }

  async function revoke() {
    setPending(true);
    setNote(null);
    const outcome = await revokeSmsChannelAction();
    setPending(false);
    if (outcome.status === 'revoked' || outcome.status === 'not_found') {
      setEnrolled(false);
      setMasked(null);
      setPhone('');
      setPhase('phone');
      setNote('Texts are off. Add a number any time to turn them back on.');
      return;
    }
    setNote('Couldn’t turn that off just now — please try again.');
  }

  // Enrolled: show the verified number + an off switch.
  if (enrolled && masked) {
    return (
      <div className="flex flex-col gap-y-3 max-w-md">
        <div className="panel-oat px-6 py-5 flex items-center justify-between gap-x-6">
          <div>
            <p className="font-medium text-spruce">{masked}</p>
            <p className="meta mt-0.5">Verified · your week arrives by text</p>
          </div>
          <Button variant="secondary" onClick={revoke} disabled={pending}>
            Turn off
          </Button>
        </div>
        {note ? <NoteLine text={note} /> : null}
      </div>
    );
  }

  // Sender not provisioned yet: honest launch state, no dead form.
  if (!senderConfigured) {
    return (
      <div className="panel-oat px-6 py-5 max-w-md">
        <p className="font-medium text-spruce">Get your week by text</p>
        <p className="meta mt-1 leading-relaxed">
          Soon you’ll be able to add your phone number and get your family’s weekly plan and
          reminders as a text. We’ll invite you to set it up when texting launches.
        </p>
      </div>
    );
  }

  // Not enrolled + sender live: the enrolment flow.
  return (
    <div className="flex flex-col gap-y-4 max-w-md">
      {phase === 'phone' ? (
        <>
          <Field
            label="Mobile number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(519) 555-1234"
            value={phone}
            onChange={(e) => setPhone(e.currentTarget.value)}
            hint="Canadian or US mobile number."
          />
          <p className="meta leading-relaxed">{SMS_CONSENT_COPY}</p>
          <div>
            <Button onClick={sendCode} disabled={pending || phone.trim().length === 0}>
              {pending ? 'Sending…' : 'Send code'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field
            label="Verification code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            hint={masked ? `Sent to ${masked}.` : undefined}
          />
          <div className="flex items-center gap-x-3">
            <Button onClick={verify} disabled={pending || code.trim().length === 0}>
              {pending ? 'Verifying…' : 'Verify'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPhase('phone');
                setCode('');
                setNote(null);
              }}
              disabled={pending}
            >
              Use a different number
            </Button>
          </div>
        </>
      )}
      {note ? <NoteLine text={note} /> : null}
    </div>
  );
}

function NoteLine({ text }: { text: string }) {
  return (
    <output className="meta text-slate-green block" aria-live="polite">
      {text}
    </output>
  );
}
