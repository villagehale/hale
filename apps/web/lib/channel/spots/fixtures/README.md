# Saved PerfectMind course pages

Seven real responses, saved as served, so the reader is tested against the bytes a
tenant actually returns rather than against a page we imagined. `availability.test.ts`
explains what each one is for.

**Two fields are redacted, and must stay redacted when a page is refreshed:**

- `maps.googleapis.com/maps/api/js?key=` → `AIzaREDACTED`. PerfectMind's browser key,
  not ours to publish, and an `AIza` literal trips GitHub push protection on the PR.
- `__RequestVerificationToken` → `value=""`. Inert without its paired cookie, but
  secret-shaped and read by nothing here.

Neither is inside the `var eventInfo` object literal the reader parses, so redacting
them changes no reading — proved by re-running the suites over every fixture before and
after.
