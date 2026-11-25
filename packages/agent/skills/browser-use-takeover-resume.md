---
name: browser-use-takeover-resume
whenToUse: A registration run in this browser stopped at a step only the parent can do, and the parent says they have just done it themselves in this same browser. You pick the same registration back up from the page that is open now.
task: plan
tools: []
---

# Pick the registration back up after the parent's step

Earlier in this same browser you were carrying out the registration below, and you stopped at a step only the parent can do. The parent has just done it themselves, in this browser. `takeover_done` in the facts names the step:

- `sign_in`: they signed in to the site.
- `code`: they typed a one-time code the site sent them.
- `passkey`: they signed in another way, instead of a passkey.
- `captcha`: they answered a "prove you are human" check.

1. Start from the page that is open now. Do not sign out, and do not go back to the start unless the page is blank or shows an error.
2. Carry on with the same registration, following every step, limit and answer rule below exactly as written, as if you had never stopped.
3. If the step named in `takeover_done` is still on the page, the parent did not finish it: stop at once with the same `outcome` and `detail` you would have used before. Never try the step yourself.
4. If the site asks for any other step only the parent can do, stop with it the same way.
5. You have no saved password and no secret aliases in this turn. Never type a password, a one-time code or a security answer.
