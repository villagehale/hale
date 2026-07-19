# Hale Mobile — Publishing & Testing Guide

How `@hale/mobile` (Expo SDK 56) goes from this repo to TestFlight and the App Store.
Tooling: **EAS** (Expo Application Services) — build in the cloud, no Mac required.

## Who does what

| Step | Who | Why |
|------|-----|-----|
| App code, `eas.json`, `app.json`, store metadata draft | **Claude** | code + config |
| `eas login` (Expo account) | **You** | your account/credentials |
| Apple Developer enrollment ($99/yr) + App Store Connect app record | **You** | legal identity, payment |
| Apple credentials (certs/profiles — EAS can manage them) | **You** approve | tied to your Apple ID |
| `eas build` / `eas submit` final run | **You** (or me with your tokens) | spends build quota; outward-facing |
| App Store privacy answers + review submission | **You** | legal attestation about data |

Nothing here touches the App Store until you run the submit — the loop builds everything *up to* that line.

## 0. One-time prerequisites

```bash
npm i -g eas-cli            # EAS CLI
eas login                   # your Expo account (YOU)
```
- Apple Developer Program membership active (https://developer.apple.com — YOU).
- An App Store Connect app record (bundle id e.g. `family.villagehale.app`) — create once.

## 1. Configure the project (Claude preps, committed to the repo)

```bash
cd apps/mobile
eas build:configure        # generates eas.json with build profiles
```
`eas.json` profiles we use:
- **development** — dev client, internal only (debugging on a device).
- **preview** — internal distribution / TestFlight (the real-device test gate).
- **production** — App Store build.

`app.json` must set: `ios.bundleIdentifier`, `version`, `ios.buildNumber`, app icon, splash, and the **privacy usage strings** (camera/mic for milestone photos + voice — required or Apple rejects).

## 2. Build (cloud, no Mac)

```bash
eas build --platform ios --profile preview      # → installable build URL
eas build --platform ios --profile production    # → App Store build
```
EAS provisions certs/profiles for you (it will ask to manage Apple credentials — approve once).

## 3. Test on real devices — TestFlight (this is our device gate)

> There is **no iOS simulator in the Claude build environment**, so device testing happens here, by you. During development we iterate UI via **Expo web previews + screenshots**; TestFlight is where it's validated on a real iPhone.

```bash
eas submit --platform ios --profile production   # uploads the build; TestFlight is the automatic pre-review stage
```
- In App Store Connect → TestFlight: add internal testers (you) / external testers (beta families).
- Testers install the **TestFlight** app and get the build over the air.
- New JS-only fixes can ship to testers instantly without a rebuild via OTA (step 5).

## 4. Submit to the App Store

```bash
eas submit --platform ios --profile production
```
Then in **App Store Connect**:
- Screenshots (6.7" + 6.1" required), description, keywords, support URL, privacy policy URL (`https://app.villagehale.com/privacy`).
- **App Privacy "nutrition label"** — Hale handles child/family data, so declare it honestly: data linked to the user, used for app functionality, not for tracking. This mirrors hard rule #1 (PIPEDA/Law 25). Under-13 / Kids-category rules: Hale is a *parent's* tool, not a kids' app — position as 4+/parenting, parent-account-gated.
- Submit for review → Apple review is typically **~24–72h**.

## 5. Updates after launch (OTA — no re-review)

```bash
eas update --branch production --message "copy fix"
```
JS/asset-only changes (copy, layout, logic) reach users without an App Store review. Native changes (new permissions, SDK bumps) require a new `eas build` + resubmit.

## Hale-specific gotchas

- **Auth:** mobile uses a token flow (not web cookies) — Google sign-in via `expo-auth-session` + a mobile credentials path. Test the full sign-in on TestFlight before submitting.
- **Push:** Apple Push (APNs) keys are configured in EAS; verify a real push lands on a TestFlight device.
- **Privacy strings:** camera (milestone photos), microphone (voice Ask + voice log) — every permission needs a clear `NS*UsageDescription` in `app.json` or Apple rejects.
- **Data residency:** the app is a client of the Canadian backend; no child data is stored on-device beyond cache. Keep it that way (rule #1).

## Current status

- [x] App scaffolded, monorepo-integrated, gates green (tsc, expo-doctor 21/21, expo export).
- [ ] `eas.json` + `app.json` production config (Claude — upcoming cycle).
- [ ] First `eas build --profile production` → submit → TestFlight (needs your `eas login`; only `submit.production` exists in eas.json).
- [ ] App Store Connect record + privacy answers (You).
- [ ] Production submit (You).
