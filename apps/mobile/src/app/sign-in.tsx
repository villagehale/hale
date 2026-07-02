import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Screen } from '@/components/ui/screen';
import { useAuth } from '@/lib/auth';
import { exchangeGoogleIdToken, signInWithPassword } from '@/lib/auth-api';

WebBrowser.maybeCompleteAuthSession();

// TODO(mobile-auth): set these in app.json `extra.google` once the Google OAuth
// clients exist. Unset → the Google button is shown disabled (no inline secrets,
// and the auth hook is never called without a client id, which would throw).
const googleConfig = (Constants.expoConfig?.extra?.google ?? {}) as {
  iosClientId?: string;
  webClientId?: string;
};
const googleReady = !!googleConfig.iosClientId || !!googleConfig.webClientId;

function GoogleButton({ onError }: { onError: (message: string) => void }) {
  const { signIn } = useAuth();
  // useIdTokenAuthRequest asks Google for an OpenID id_token (response.params.
  // id_token) — the credential /api/mobile/auth/google verifies — rather than the
  // access token useAuthRequest returns.
  const [, response, promptGoogle] = Google.useIdTokenAuthRequest({
    iosClientId: googleConfig.iosClientId,
    webClientId: googleConfig.webClientId,
  });

  useEffect(() => {
    if (response?.type !== 'success') return;
    const idToken = response.params?.id_token;
    if (!idToken) return;
    exchangeGoogleIdToken(idToken)
      .then(({ token }) => signIn(token))
      .catch((e: Error) => onError(e.message));
  }, [response, signIn, onError]);

  return <Button label="Continue with Google" variant="secondary" onPress={() => promptGoogle()} />;
}

export default function SignInScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onPassword = async () => {
    setError(null);
    setBusy(true);
    try {
      const { token } = await signInWithPassword(email.trim(), password);
      await signIn(token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll className="gap-6">
      <View className="gap-2 pt-8">
        <AppText variant="display">Welcome to Hale</AppText>
        <AppText variant="body">Sign in to pick up where your family left off.</AppText>
      </View>

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
          placeholder="Your password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
        />
        {error ? (
          <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
            {error}
          </AppText>
        ) : null}
        <Button label={busy ? 'Signing in…' : 'Sign in'} onPress={onPassword} className="mt-1" />
      </View>

      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-rule" />
        <AppText variant="meta">or</AppText>
        <View className="h-px flex-1 bg-rule" />
      </View>

      {googleReady ? (
        <GoogleButton onError={setError} />
      ) : (
        <Button
          label="Continue with Google"
          variant="secondary"
          onPress={() => setError('Google sign-in is not configured yet.')}
        />
      )}
    </Screen>
  );
}
