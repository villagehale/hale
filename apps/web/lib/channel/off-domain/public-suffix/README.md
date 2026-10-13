# Public Suffix List

`suffixes.json` is the list of public suffixes, for one reader: `../answer.ts`, which
uses it to tell when a word in a composed reply is a link written without `https://`
or `www.`. A token a rule in this list covers (`free-prizes.com/claim`, `example.co.uk`)
is a link, and is held to the rule every link in a reply is held to: its host is one
this turn's search returned, or the reply is not sent. A phone makes such a token
tappable as it stands, which is why the scheme cannot be what decides it.

The list's own default rule, a lone `*`, is not in `suffixes.json`. A dotted word is a
link only when an explicit rule names its suffix, which is why `Node.js` and `7 a.m.`
are not links.

`public_suffix_list.dat` is the file the list was built from, header included.
`build.mjs` reads that file as text and writes `suffixes.json`.

This list replaced the IANA root-zone table that used to live beside this directory
(Barton, 2026-10-13). That table is not part of the build.

## Source

| File | From | Version line | SHA-256 of the download |
|---|---|---|---|
| `public_suffix_list.dat` | https://publicsuffix.org/list/public_suffix_list.dat | `// VERSION: 2026-10-07_07-28-19_UTC` | `ba7d836c0ea57a8bcf9f1fcb868066a7554bed029b441ecc6204ad8494a32612` |

Retrieved 2026-10-13. Pull the list from that URL only, as its header asks.

SHA-256 of `suffixes.json` as built from that download:
`d39dd6321cde4055aed5d24e90cdd136f5da7805e2c30c29445def04a3b503ba`

## Licence

The Public Suffix List is subject to the Mozilla Public License, version 2.0. The
licence header is the top of `public_suffix_list.dat`. A copy of the licence is at
https://mozilla.org/MPL/2.0/.

Mozilla Public License 2.0 is a file-level weak copyleft. This list is a separate
file from the rest of the program. Using it here does not relicense the rest of the
repository.

## Refreshing

Download the list into an empty directory, then, from this directory:

```sh
node build.mjs <path>/public_suffix_list.dat
```

The download is untrusted data: the script reads it as text and evaluates none of it.
Update the version line and both checksums above.
