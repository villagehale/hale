import { notFound } from 'next/navigation';
import {
  SIGNUP_TEST_CAPTCHA_WORD,
  SIGNUP_TEST_CODE,
  signupTestChallenge,
  signupTestFormEnabled,
} from '~/lib/signup/test-form';
import { HarborButton, HarborField, HarborShell } from '../harbor';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ kind?: string; err?: string }>;
}

/**
 * VIL-718 · Preview-only Harbor Rec steps that only the parent can do: a texted code, a
 * passkey prompt, and a "prove you are human" check. Fake provider chrome, not a Hale
 * surface; production 404s. Each one posts to /api/demo/signup-test/challenge.
 */
export default async function SignupTestChallengePage({ searchParams }: PageProps) {
  if (!signupTestFormEnabled()) notFound();
  const { kind: raw, err } = await searchParams;
  const kind = signupTestChallenge(raw);
  if (!kind) notFound();
  const action = '/api/demo/signup-test/challenge';
  if (kind === 'code') {
    return (
      <HarborShell title="Enter your code">
        <p>We texted a 6-digit code to the phone on your account.</p>
        <p style={{ fontSize: 13, opacity: 0.7 }}>Test site: the code is {SIGNUP_TEST_CODE}.</p>
        {err ? <p role="alert">That code didn&apos;t match.</p> : null}
        <form method="post" action={action}>
          <input type="hidden" name="kind" value="code" />
          <HarborField label="Code" name="answer" autoComplete="one-time-code" />
          <HarborButton>Verify</HarborButton>
        </form>
      </HarborShell>
    );
  }
  if (kind === 'passkey') {
    return (
      <HarborShell title="Sign in with a passkey">
        <p>Use the passkey saved on your device to continue.</p>
        {err ? <p role="alert">No passkey was found on this device.</p> : null}
        <form method="post" action={action}>
          <input type="hidden" name="kind" value="passkey" />
          <input type="hidden" name="answer" value="" />
          <HarborButton>Use passkey</HarborButton>
        </form>
        <p>
          <a href="?kind=code">Try another way</a>
        </p>
      </HarborShell>
    );
  }
  return (
    <HarborShell title="Verify you are human">
      <p>Type the word in the box to continue.</p>
      <p
        aria-hidden
        style={{
          display: 'inline-block',
          padding: '8px 16px',
          letterSpacing: '0.4em',
          fontStyle: 'italic',
          background: '#d9d2c3',
          transform: 'skewX(-12deg)',
        }}
      >
        {SIGNUP_TEST_CAPTCHA_WORD.toUpperCase()}
      </p>
      {err ? <p role="alert">That wasn&apos;t it. Try again.</p> : null}
      <form method="post" action={action}>
        <input type="hidden" name="kind" value="captcha" />
        <HarborField label="The word" name="answer" />
        <HarborButton>Verify</HarborButton>
      </form>
    </HarborShell>
  );
}
