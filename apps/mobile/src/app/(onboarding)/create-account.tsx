import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { ScreenHeader } from '@/components/ui/screen-header';
import { useMeadowColor } from '@/constants/meadow';
import { useAuth } from '@/lib/auth';
import { exchangeGoogleIdToken, signUpWithPassword } from '@/lib/auth-api';

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
      .then(({ token }) => signIn(token))
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

  if (sentTo) return <VerifyEmail email={sentTo} />;

  return (
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen scroll className="gap-6">
        <ScreenHeader title="Create your account" back />
        <AppText variant="body" className="-mt-2">
          Last step — this saves your family so Hale can start helping.
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

/**
 * The "check your email" state after an email sign-up. Verification is required, so
 * no session exists yet — the parent taps the emailed link (out of app), comes
 * back, and signs in; the saved draft is then submitted by the resume effect in the
 * root layout. From here they go to the existing sign-in screen.
 */
function VerifyEmail({ email }: { email: string }) {
  const accent = useMeadowColor('accentFill');
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
            We sent a link to {email}. Tap it to confirm your address, then come back and sign in —
            your setup is saved and waiting.
          </AppText>
        </View>
      </View>
      <View className="gap-3">
        <Button label="I've verified — sign in" onPress={() => router.replace('/sign-in')} />
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
