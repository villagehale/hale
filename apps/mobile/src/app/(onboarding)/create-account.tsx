import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useMeadowColor } from '@/constants/meadow';
import { useAuth } from '@/lib/auth';
import { exchangeGoogleIdToken, signInWithPassword, signUpWithPassword } from '@/lib/auth-api';
import { setPostAuthHold } from '@/lib/post-auth-hold';

WebBrowser.maybeCompleteAuthSession();

// Mirrors sign-in.tsx: Google is enabled only once the OAuth client ids are set in
// app.json extra.google. Unset → the button shows disabled, and the auth hook is
// never called without a client id (which would throw).
const googleConfig = (Constants.expoConfig?.extra?.google ?? {}) as {
  iosClientId?: string;
  webClientId?: string;
};
const googleReady = !!googleConfig.iosClientId || !!googleConfig.webClientId;

/**
 * Google is already-verified, so signIn(token) mints the session immediately. The
 * saved draft is then submitted by the single resume-onboarding effect in the root
 * layout (which also handles the email-verify path) — one submit path, no race — and
 * that effect's routing gate moves the now-authed user into the app.
 */
function GoogleButton({
  onError,
  onBusy,
}: {
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { signIn } = useAuth();
  const [, response, promptGoogle] = Google.useIdTokenAuthRequest({
    iosClientId: googleConfig.iosClientId,
    webClientId: googleConfig.webClientId,
  });

  useEffect(() => {
    if (response?.type !== 'success') return;
    const idToken = response.params?.id_token;
    if (!idToken) return;
    onBusy(true);
    exchangeGoogleIdToken(idToken)
      .then(({ token }) => {
        // Hold the gate's tabs-bounce BEFORE the token commits (see post-auth-hold):
        // the resume hook provisions the family, then routes to /connect itself.
        setPostAuthHold(true);
        signIn(token);
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => onBusy(false));
  }, [response, signIn, onError, onBusy]);

  return <Button label="Continue with Google" variant="secondary" onPress={() => promptGoogle()} />;
}

export default function CreateAccountScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const onEmailSignUp = async () => {
    setError(null);
    setBusy(true);
    try {
      const trimmed = email.trim();
      await signUpWithPassword(trimmed, password);
      // The draft stays saved — it's submitted after the user verifies + signs in
      // (the resume effect in the root layout).
      setSentTo(trimmed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) return <VerifyEmail email={sentTo} password={password} />;

  return (
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen scroll className="gap-6">
        <ScreenHeader title="Save your family" back />
        <AppText variant="body" className="-mt-2">
          Last step — create your account and Hale starts helping. Everything you just set up is
          saved.
        </AppText>

        <View className="gap-3">
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Choose a password"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="password-new"
            textContentType="newPassword"
          />
          {error ? (
            <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}
          <Button
            label={busy ? 'Creating…' : 'Create account'}
            onPress={onEmailSignUp}
            disabled={busy || !email.trim() || !password}
            className="mt-1"
          />
        </View>

        <View className="flex-row items-center gap-3">
          <View className="h-px flex-1 bg-rule" />
          <AppText variant="meta">or</AppText>
          <View className="h-px flex-1 bg-rule" />
        </View>

        {googleReady ? (
          <GoogleButton onError={setError} onBusy={setBusy} />
        ) : (
          <Button label="Google sign-up unavailable" variant="secondary" disabled />
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}

// Under the auth route's 20-per-minute IP cap: a 6s poll is 10/min, leaving
// headroom for the manual button and the resend.
const VERIFY_POLL_MS = 6000;
const RESEND_COOLDOWN_MS = 30_000;

/**
 * The "check your email" state after an email sign-up — with the dead end
 * removed. The just-typed credentials are still in memory (never persisted), so
 * while the parent taps the emailed link this screen quietly retries sign-in
 * every few seconds; the moment verification lands, the session mints and the
 * root layout's gate + resume effect carry them into the app with their saved
 * setup. An unverified attempt is a generic 401 by design (anti-enumeration),
 * so poll failures are silent — the credentials were accepted at sign-up
 * seconds ago. "Resend email" re-POSTs sign-up, which re-fires the
 * verification email for an unverified account (same anti-enumeration
 * response). If the app is killed first, the old path still works: sign in
 * manually, the draft resumes.
 */
function VerifyEmail({ email, password }: { email: string; password: string }) {
  const accent = useMeadowColor('accentFill');
  const { signIn } = useAuth();
  const [checking, setChecking] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const attempting = useRef(false);

  const tryVerifiedSignIn = useCallback(async (): Promise<boolean> => {
    if (attempting.current) return false;
    attempting.current = true;
    try {
      const { token } = await signInWithPassword(email, password);
      setPostAuthHold(true);
      await signIn(token);
      return true;
    } catch {
      // Generic 401 — verification hasn't landed yet. Keep waiting.
      return false;
    } finally {
      attempting.current = false;
    }
  }, [email, password, signIn]);

  useEffect(() => {
    const timer = setInterval(() => {
      void tryVerifiedSignIn();
    }, VERIFY_POLL_MS);
    return () => clearInterval(timer);
  }, [tryVerifiedSignIn]);

  const onManualCheck = async () => {
    setChecking(true);
    setNotYet(false);
    const ok = await tryVerifiedSignIn();
    if (!ok) setNotYet(true);
    setChecking(false);
  };

  const onResend = async () => {
    setResendState('sending');
    try {
      await signUpWithPassword(email, password);
      setResendState('sent');
    } catch {
      setResendState('idle');
      return;
    }
    setTimeout(() => setResendState('idle'), RESEND_COOLDOWN_MS);
  };

  return (
    <Screen className="justify-center gap-6">
      <View className="items-center gap-5">
        <View className="h-20 w-20 items-center justify-center rounded-full bg-accent-tint">
          <Icon name="envelope.fill" size={32} color={accent} />
        </View>
        <View className="items-center gap-3">
          <AppText variant="display" className="text-center">
            Verify your email
          </AppText>
          <AppText variant="body" className="max-w-[320px] text-center">
            We sent a link to {email}. Tap it to confirm — the moment it&rsquo;s verified,
            you&rsquo;ll be signed in here automatically. Your setup is saved.
          </AppText>
        </View>
      </View>
      <View className="gap-3">
        <Button
          label={checking ? 'Checking…' : "I've tapped the link"}
          onPress={onManualCheck}
          disabled={checking}
        />
        {notYet ? (
          <AppText
            variant="meta"
            className="text-center text-ink-3"
            accessibilityLiveRegion="polite"
          >
            Not verified yet — tap the link in your email first. We&rsquo;ll keep checking.
          </AppText>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Resend the verification email"
          onPress={onResend}
          disabled={resendState !== 'idle'}
          className="items-center py-1 active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            {resendState === 'sent'
              ? 'Sent — check your inbox'
              : resendState === 'sending'
                ? 'Sending…'
                : 'Resend the email'}
          </AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Use a different email"
          onPress={() => router.back()}
          className="items-center py-1 active:opacity-70"
        >
          <AppText variant="meta" className="text-ink-3">
            Use a different email
          </AppText>
        </Pressable>
      </View>
    </Screen>
  );
}
