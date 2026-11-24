# Claude Code handoff (Dec 1 launch)

Barton runs Claude Code on his Mac from a fresh clone of `villagehale/hale`. Hard rules and Mac setup live in the repo root `CLAUDE.md` (section **Dec 1 launch hard rules**). This folder holds the original per-item briefs.

Start each ticket from its Linear issue (the ticket wins if it disagrees with a brief). Check out the branch named in the ticket, or `main` if there is no branch yet. Merge `origin/main` before you push. Never use stacked PRs. Never push to `main`. Never run tests or evals with Production secrets loaded.

## Briefs

| Brief | Ticket | Branch |
|---|---|---|
| [CC1.md](./CC1.md) | VIL-717 | `cc/vil-717-ack-eta` ([#1326](https://github.com/villagehale/hale/pull/1326)) |
| [CC2.md](./CC2.md) | VIL-718 | `cc/vil-718-takeover-link` ([#1325](https://github.com/villagehale/hale/pull/1325)) |
| [CC3.md](./CC3.md) | VIL-719 | `cc/vil-719-ask-policy-tiers` ([#1327](https://github.com/villagehale/hale/pull/1327)) |
| [CC4.md](./CC4.md) | VIL-720 | `cc/vil-720-bring-items` |
| [CC5.md](./CC5.md) | VIL-721 | `cc/vil-721-thread-onboarding-v2` ([#1328](https://github.com/villagehale/hale/pull/1328)) |
| [CC6.md](./CC6.md) | VIL-722 | `cc/vil-722-retention-cap` |
| [CC7.md](./CC7.md) | VIL-723 | `cursor/model-read-sweep-728e` ([#1213](https://github.com/villagehale/hale/pull/1213)) |
| [CC9.md](./CC9.md) | VIL-706 | `cursor/join-door-model-copy-26fd` ([#1318](https://github.com/villagehale/hale/pull/1318)) |
| [CC10.md](./CC10.md) | VIL-727 | `cc/vil-727-group-join-intro` |
| [CC11.md](./CC11.md) | VIL-728 | `cc/vil-728-group-loop-guard` |

There is no CC8: referral codes were dropped.

Suggested first tickets (see Linear for the live ordered list): the claim-reader fix (from `main`), then [#1310](https://github.com/villagehale/hale/pull/1310) (`cursor/vil-560-injection-signup-055e`), then [#1268](https://github.com/villagehale/hale/pull/1268) (`feat/group-scenes-proven`).
