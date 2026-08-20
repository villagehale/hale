# Voice relay — how to hear it, without touching the production number

Hale's voice front door is live on the production Twilio number. Repointing that
number's voice webhook at a preview deployment is the one thing this runbook exists to
avoid: it is a production change, it affects every parent who calls while it is in
place, and rolling it back is a second production change made under time pressure.

There is a better technique. **A Twilio outbound call can carry its TwiML inline.** The
REST API's `Twiml` parameter takes a document as a string, so a single API call places a
call to your own phone and hands Twilio a `<Connect><ConversationRelay>` pointed at
whatever URL you like — a preview deployment, a tunnel, anything. Nothing about the
production number's configuration is read or changed. The call is billed as an ordinary
outbound call.

---

## What M0 established (2026-08-19)

The spike question was whether a Next.js App Router route on Vercel can host the
WebSocket at all. It can. Evidence, from real preview deployments of this branch:

| Check | Result |
| --- | --- |
| Upgrade reaches the function | `GET /api/channels/twilio/relay 101` in the runtime log |
| Region | `yul1` (pinned in `apps/web/vercel.json`) |
| Next version | 15.5.18, App Router, `runtime = 'nodejs'` |
| Work AFTER the handler returns still reaches the wire | frames at +1101ms and +1500ms, from a turn that awaited two 400ms timers |
| A forged ticket is refused before anything is composed | one `{"type":"end","handoffData":"{\"reasonCode\":\"unauthorized\"}"}` frame, then close |

Preview used for the passing run:
`wss://hale-fnnpgdaq1-village-hale-project.vercel.app/api/channels/twilio/relay`

### The landmine the spike found

The first two deploys upgraded successfully and then **killed the instance on the first
frame**:

```
TypeError: b.unmask is not a function
    at a.exports.unmask (.next/server/chunks/3203.js:1:41387)
Node.js process exited with exit status: 129.
```

`ws` probes for the optional native `bufferutil` addon inside a `try/catch`. Next's
webpack config aliases `bufferutil` to `false`, and an aliased-to-false module resolves
to `{}` rather than throwing — so `ws` installs its native fast path over an empty object
and calls `unmask` on it for every masked frame. Every frame a WebSocket *client* sends
is masked, so this fires on every call, always.

`serverExternalPackages: ['ws']` does **not** fix it — `ws` stays in the bundle (verified
by grepping `.next/server/chunks`). The fix is `WS_NO_BUFFER_UTIL`, ws's own documented
switch, set at the top of the route module so it cannot be lost when someone provisions a
new environment. See `apps/web/app/api/channels/twilio/relay/route.ts`.

---

## Probe A — the socket, without a phone (60 seconds)

Proves the upgrade, the ticket gate, and the turn loop. No Twilio, no phone, no cost.

1. Deploy a preview: `npx vercel deploy` from the repo root. Note the preview URL.
2. Pull that environment's key so you can mint a ticket the deployment will accept:
   `npx vercel env pull <somewhere outside the repo>/.env.preview --environment=preview`
3. Mint a ticket exactly as `apps/web/lib/channel/twilio/relay-token.ts` does —
   HKDF-SHA256 of `APP_ENCRYPTION_KEY` under the label `hale-voice-relay-v1`, then
   HMAC-SHA256 over `callSid.familyId.parentUserId.exp` — and connect to
   `wss://<preview-host>/api/channels/twilio/relay?t=<ticket>`.
4. Send a `setup` frame carrying the same `callSid`, then a `prompt` frame with
   `last: true`.
5. Expect `text` frames ending in one with `"last": true`. A single `end` frame with
   `reasonCode: unauthorized` means the ticket did not check out.

Use `familyId` / `parentUserId` of a REAL test family if you want the turn to say
anything about a week; any uuid is enough to prove the transport.

## Probe B — a real call to your own phone (the one that proves the product)

**Never repoint the production number's voice webhook to do this.**

1. Deploy a preview and note its hostname.
2. Mint a ticket as above. Pick your own `callSid` value — it only has to match what you
   put in the TwiML, and Twilio's real `CallSid` for this call will NOT match it, so for
   probe B mint the ticket against the CallSid Twilio reports (see step 4) or run the
   probe against a build whose voice webhook mints the ticket for you.
3. Place the call, handing Twilio the document inline:

   ```bash
   curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls.json" \
     -u "$TWILIO_API_KEY_SID:$TWILIO_API_KEY_SECRET" \
     --data-urlencode "To=+1<your mobile>" \
     --data-urlencode "From=$TWILIO_FROM_NUMBER" \
     --data-urlencode 'Twiml=<Response><Connect><ConversationRelay url="wss://<preview-host>/api/channels/twilio/relay?t=<ticket>" welcomeGreeting="Testing the relay." ttsProvider="ElevenLabs" voice="XrExE9yKIg1WjnnlVkGX-flash_v2_5" /></Connect></Response>'
   ```

4. Answer. You should hear the greeting, then hear your own words come back (M0) or hear
   Hale answer (M1). `CallSid` is in the API response and in the runtime log line for the
   upgrade — that is the value the ticket must be bound to.

5. Watch it: `npx vercel inspect <preview-host> --logs`, or the runtime logs in the
   dashboard. The upgrade shows as a `101`.

### The full end-to-end, when you are ready to hear it as a parent does

The only way to exercise the REAL path (production number → voice webhook resolves an
enrolled caller → mints its own ticket → TwiML → socket) is to call the production
number from an enrolled phone against a deployment that has the branch on it. That is a
production deploy, not a preview, and it is a founder decision — the preview URL is not
reachable as a Twilio webhook target for the production number without changing that
number's configuration, which this runbook exists to avoid.

---

## What is deliberately not here

- **No recording.** No `record` attribute and no `intelligenceService`, so Twilio retains
  no transcript and no audio. The `channel_messages` rows are the only record of what was
  said (rule #1).
- **No production webhook change.** Both probes above leave the production number's
  configuration untouched.
