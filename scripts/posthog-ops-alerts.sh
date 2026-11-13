#!/usr/bin/env bash
# List the PostHog insight alerts to create for Hale launch (Slack #ops).
# This does not call the PostHog API; it is the checklist beside docs/posthog-ops-alerts.md.
# Destination: Slack #ops. Keep /api/cron/ops-daily until POSTHOG_OPS_ALERTS_ENABLED
# is true in Prod and Barton retires the daily post.

set -euo pipefail

cat <<'EOF'
PostHog → Insights → Alerts  (product project, NEXT_PUBLIC_POSTHOG_KEY)
Destination: Slack #ops

1. send_failed > 0 in 15m
   event: send_failed
   window: last 15 minutes
   threshold: total count > 0

2. message_unanswered > 0
   event: message_unanswered
   window: last 15 minutes
   threshold: total count > 0

3. turn_failed spike
   event: turn_failed
   window: last 15 minutes vs previous 15 minutes
   threshold: current >= 3 AND current >= 3× previous

4. registration_run_failed > 0
   event: registration_run_failed
   window: last 15 minutes
   threshold: total count > 0

Flags (Prod, after merge; exact string true):
  POSTHOG_PRODUCT_EVENTS_ENABLED=true
  POSTHOG_ERROR_TRACKING_ENABLED=true
  POSTHOG_ID_SALT=<hmac secret>
  POSTHOG_OPS_ALERTS_ENABLED=true   # does not skip the daily #ops post

See docs/posthog-ops-alerts.md for the dashboard recipes
(weekly active families, 4-/8-week retention, things done per family per week,
multi-family groups).
EOF
