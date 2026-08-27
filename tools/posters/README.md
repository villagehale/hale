# Neighborhood posters

The Toronto neighborhood poster system: shared chrome (Hawaii shore, `/HAH-LEH/`, “The family assistant you text.”, amber free-to-start bar, navy scan-to-text footer) plus one plate per location.

Each plate has its own QR. The QR is an `sms:` deep link that prefills `Hi (via <source-code>)`. Indoor EarlyON boards use `earlyon-*` codes; City columns use `poster-*` and are not generated here.

```
node tools/posters/render.mjs earlyon-ossington
node --test tools/posters/plates.test.mjs
# PDF/PNG/HTML land in tools/posters/print/ (`out/` is gitignored).
```
