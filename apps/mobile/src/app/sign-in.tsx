import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Screen } from '@/components/ui/screen';
import { API_BASE } from '@/lib/api-client';
import { appleIdentityToken } from '@/lib/apple-credential';
import { useAuth } from '@/lib/auth';
import {
  exchangeAppleIdentityToken,
  exchangeGoogleIdToken,
  signInWithPassword,
} from '@/lib/auth-api';

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

// Apple HIG requires Sign in with Apple wherever another social sign-in is offered
// on iOS. Rendered only where AppleAuthentication.isAvailableAsync() is true
// (device iOS) — web/Android render nothing, so there is no dead button. The native
// AppleAuthenticationButton carries Apple's required badge/styling to pass review.
function AppleButton({ onError }: { onError: (message: string) => void }) {
  const { signIn } = useAuth();

  const onPress = async () => {
    try {
      // Replay defense: send Apple the SHA-256 of a random nonce (which it echoes
      // into the identity token's `nonce` claim), and send the raw nonce to the
      // server, which re-hashes it and matches the claim. The hash must be HEX to
      // match the server's createHash('sha256').digest('hex').
      const rawNonce = Crypto.randomUUID();
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce,
      );
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });
      const { token } = await exchangeAppleIdentityToken(
        appleIdentityToken(credential),
        rawNonce,
      );
      await signIn(token);
    } catch (e) {
      // A user cancelling the Apple sheet is not an error to surface.
      if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      onError((e as Error).message);
    }
  };

  return (
    <AppleAuthentication.AppleAuthenticationButton
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
      cornerRadius={9999}
      style={{ minHeight: 48 }}
      onPress={onPress}
    />
  );
}

export default function SignInScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    AppleAuthentication.isAvailableAsync().then((ok) => {
      if (active) setAppleAvailable(ok);
    });
    return () => {
      active = false;
    };
  }, []);

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
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
        <Button
          label={busy ? 'Signing in…' : 'Sign in'}
          onPress={onPassword}
          disabled={busy}
          className="mt-1"
        />
      </View>

      <View className="flex-row items-center gap-3">
        <View className="h-px flex-1 bg-rule" />
        <AppText variant="meta">or</AppText>
        <View className="h-px flex-1 bg-rule" />
      </View>

      {googleReady ? (
        <GoogleButton onError={setError} />
      ) : (
        <Button label="Google sign-in unavailable" variant="secondary" disabled />
      )}

      {appleAvailable ? <AppleButton onError={setError} /> : null}

      {API_BASE ? (
        <View className="mt-2 items-center gap-3">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Forgot password"
            onPress={() => WebBrowser.openBrowserAsync(`${API_BASE}/forgot-password`)}
            className="active:opacity-70"
          >
            <AppText variant="meta" className="text-accent">
              Forgot password?
            </AppText>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="New to Hale, create an account"
            onPress={() => WebBrowser.openBrowserAsync(`${API_BASE}/sign-up`)}
            className="flex-row active:opacity-70"
          >
            <AppText variant="meta">New to Hale? </AppText>
            <AppText variant="meta" className="text-accent">
              Create an account
            </AppText>
          </Pressable>
        </View>
      ) : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}
