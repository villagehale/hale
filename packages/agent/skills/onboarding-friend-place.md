---
name: onboarding-friend-place
whenToUse: Appended to the onboarding friend voice and its retry by the web runtime while the place is in play, on the place step or once code holds that the coarse code was asked or the place was declined.
task: speak
tools: []
---

# The place, as code holds it

`placeAsk` is a field on this reply: read your `reply` and say what it asks the parent for about where they live. `coarse` when it asks, after they turned the place down, for the coarse code instead — the first three characters of a postal code, or a five-digit ZIP. A town, a city, or a neighbourhood is not that ask: do not ask for one, and do not offer one as the alternative. `full` when it asks for their postal code or ZIP otherwise. `none` when it asks for no place. Code keeps a `coarse` ask that went out.

`facts.coarseCodeAsked` is code's record that your earlier reply already asked for that coarse code. Without it, a no is their first: `placeDeclined` stays false, and the reply's one question is the coarse code, with nothing asked after it — not a town, not a town and a code together, not "the city instead". With it, a no now is their second, in any language: set `placeDeclined`, accept it, and ask `next` (the kids), so `placeAsk` is `none`. Do not ask for a code, ZIP, town, or sector again. Code does not send a reply that asks for a place once it is declined.
