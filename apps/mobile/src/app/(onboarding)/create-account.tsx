import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';

import { MagicLinkForm } from '@/components/hale/magic-link-form';
import { MagicLinkSent } from '@/components/hale/magic-link-sent';
import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { appleIdentityToken } from '@/lib/apple-credential';
import { useAuth } from '@/lib/auth';
import {
  exchangeAppleIdentityToken,
  exchangeGoogleIdToken,
  requestMagicLink,
} from '@/lib/auth-api';
import { openPolicy } from '@/lib/policy-links';
import { setPostAuthHold } from '@/lib/post-auth-hold';
import { useOnboardingDraft } from '@/lib/use-onboarding-draft';

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
 * that effect provisions the family, then routes into the post-auth tail (getting
 * ready → connect → your village is ready).
 */
function GoogleButton({
  disabled,
  onError,
  onBusy,
}: {
  disabled: boolean;
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
        // the resume hook provisions the family, then routes into the tail itself.
        setPostAuthHold(true);
        signIn(token);
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => onBusy(false));
  }, [response, signIn, onError, onBusy]);

  return (
    <Button
      label="Continue with Google"
      variant="secondary"
      disabled={disabled}
      onPress={() => promptGoogle()}
    />
  );
}

/**
 * Apple sign-in for the onboarding flow — the same credential path as sign-in.tsx,
 * but it sets the post-auth HOLD before signIn so a just-onboarded parent is routed
 * into the tail rather than bounced to the tabs. Rendered only where
 * isAvailableAsync() is true (device iOS), so there's never a dead button; Apple HIG
 * also requires Sign in with Apple wherever another social sign-in (Google) is
 * offered on iOS. Gated behind the consent acknowledgment like every auth control
 * here — `disabled` dims it and blocks the press so no session mints without consent.
 */
function AppleButton({
  disabled,
  onError,
}: {
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const { signIn } = useAuth();

  const onPress = async () => {
    if (disabled) return;
    try {
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
      const { token } = await exchangeAppleIdentityToken(appleIdentityToken(credential), rawNonce);
      setPostAuthHold(true);
      await signIn(token);
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      onError((e as Error).message);
    }
  };

  return (
    <View style={{ opacity: disabled ? 0.5 : 1 }} pointerEvents={disabled ? 'none' : 'auto'}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={16}
        style={{ minHeight: 48 }}
        onPress={onPress}
      />
    </View>
  );
}

/**
 * Step 10 — "I've prepared your village. Let's save it." The consent + account step,
 * and the point where the intake becomes an account. Consent is captured HERE as an
 * explicit, defaulted-OFF acknowledgment (rule #1, Law 25 affirmative act) that gates
 * every auth control: tosAccepted flips true ONLY from that tap, and it is written to
 * the draft before any provider fires, so the resume effect's submitOnboarding always
 * carries a real consent (the server's tos_required gate + the 4 provisioning consent
 * records are untouched). The auth logic itself — Google id-token, Apple identity
 * token, email magic-link — is unchanged.
 */
export default function CreateAccountScreen() {
  const { draft, update } = useOnboardingDraft();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const sun = useMeadowColor('accentFill');
  const check = useMeadowColor('onAccent');
  const trust = useMeadowColor('chipGreenIcon');

  // `agreed` mirrors the tap locally so the gate opens even in the draft's pre-
  // hydration window; the draft flag is the persisted, submitted source of truth.
  const acknowledged = draft.tosAccepted || agreed;

  useEffect(() => {
    let active = true;
    AppleAuthentication.isAvailableAsync().then((ok) => {
      if (active) setAppleAvailable(ok);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleConsent = () => {
    if (acknowledged) {
      setAgreed(false);
      update({ tosAccepted: false });
    } else {
      setAgreed(true);
      update({ tosAccepted: true });
    }
  };

  // The draft stays saved on disk — it's submitted after the parent taps the emailed
  // magic link, which deep-links back into /magic-link and the root layout's resume
  // effect provisions the family. So this step only has to confirm the send.
  if (sentTo) {
    return (
      <Screen className="justify-center">
        <MagicLinkSent
          email={sentTo}
          onResend={async () => {
            await requestMagicLink(sentTo);
          }}
          onUseDifferentEmail={() => setSentTo(null)}
        />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen scroll className="gap-5">
        <View className="items-center gap-3 pt-4">
          <View className="h-[52px] w-[52px] items-center justify-center rounded-[16px] bg-cream">
            <Icon name="sun" size={24} color={sun} />
          </View>
          <AppText variant="display" className="text-center text-[28px] leading-[35px]">
            I&rsquo;ve prepared{'\n'}your village.
          </AppText>
          <AppText variant="body" className="text-center text-ink-2">
            Let&rsquo;s save it.
          </AppText>
        </View>

        <AppText variant="body" className="text-ink-2">
          Your family&rsquo;s data is stored in Canada — AI processing runs with our US-based
          provider, exactly as the Privacy Policy describes. Built to PIPEDA and Quebec Law 25.
        </AppText>

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acknowledged }}
          accessibilityLabel="I agree to the Terms and Privacy Policy"
          onPress={toggleConsent}
          className="flex-row items-center gap-3 rounded-[14px] border border-rule bg-card p-3.5 active:opacity-90"
        >
          <View
            className={`h-6 w-6 items-center justify-center rounded-md border ${
              acknowledged ? 'border-brand bg-brand' : 'border-rule-strong'
            }`}
          >
            {acknowledged ? <Icon name="check" size={14} color={check} /> : null}
          </View>
          <AppText variant="body" className="flex-1 text-ink-2">
            I agree to the Terms & Privacy Policy.
          </AppText>
        </Pressable>
        <View className="-mt-2 flex-row flex-wrap items-center gap-x-4 gap-y-1">
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Read the Terms"
            onPress={() => openPolicy('/terms')}
            className="active:opacity-70"
          >
            <AppText variant="meta" className="text-accent">
              Read the Terms
            </AppText>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Read the Privacy Policy"
            onPress={() => openPolicy('/privacy')}
            className="active:opacity-70"
          >
            <AppText variant="meta" className="text-accent">
              Read the Privacy Policy
            </AppText>
          </Pressable>
        </View>

        <View className="gap-3">
          {appleAvailable ? <AppleButton disabled={!acknowledged} onError={setError} /> : null}
          {googleReady ? (
            <GoogleButton disabled={!acknowledged} onError={setError} onBusy={setBusy} />
          ) : (
            <Button label="Google sign-up unavailable" variant="secondary" disabled />
          )}
          {error ? (
            <AppText variant="meta" className="text-berry" accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}
        </View>

        <View className="flex-row items-center gap-3">
          <View className="h-px flex-1 bg-rule" />
          <AppText variant="meta">or</AppText>
          <View className="h-px flex-1 bg-rule" />
        </View>

        <MagicLinkForm disabled={!acknowledged || busy} onSent={setSentTo} />

        <View className="gap-2.5 pt-1">
          <TrustLine color={trust} label="Every action requires approval" />
          <TrustLine color={trust} label="Your data is never sold" />
          <TrustLine color={trust} label="Disconnect anytime" />
        </View>

        <AppText variant="meta" className="text-center text-caption">
          By continuing, you agree to our Terms & Privacy Policy.
        </AppText>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function TrustLine({ color, label }: { color: string; label: string }) {
  return (
    <View className="flex-row items-center gap-2.5">
      <Icon name="check" size={15} color={color} />
      <AppText variant="body" className="text-ink-2">
        {label}
      </AppText>
    </View>
  );
}
