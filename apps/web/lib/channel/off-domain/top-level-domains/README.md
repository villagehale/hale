# Top-level domains

`tlds.json` is the list of top-level domains, for one reader: `../answer.ts`, which uses
it to tell when a word in a composed reply is a link written without `https://` or
`www.`. A token whose last dotted part is on this list (`free-prizes.com/claim`) is a
link, and is held to the rule every link in a reply is held to: its host is one this
turn's search returned, or the reply is not sent. A phone makes such a token tappable as
it stands, which is why the scheme cannot be what decides it.

It is a table of how the domain name system is laid out. It is not a list of things a
parent or a model might say.

## Shape

A JSON array of 1,437 names in lower case, in the source's order. 151 of them begin with
`xn--`: those are the encoded forms of names in other scripts. The reader puts a last
part into that form before it looks it up, so a link under one of those names is
recognized however it is written: in its own script or encoded.

## Source

| File | From | Version line | SHA-256 of the download |
|---|---|---|---|
| `tlds-alpha-by-domain.txt` | https://data.iana.org/TLD/tlds-alpha-by-domain.txt | `# Version 2026101200, Last Updated Mon Oct 12 07:07:01 2026 UTC` | `45d9f126c1f5af44e41a40bbf84feafd38ca16806cb094618fa0ef6371cbdd16` |

Retrieved 2026-10-12. The Internet Assigned Numbers Authority (IANA) publishes the file
and regenerates it daily, so a later download has another version line and checksum.

SHA-256 of `tlds.json` as built from that download:
`ec9f44c1cd9d12eff8fd841dd0402226e5f17225f88524d069033f1410fb860d`

## Licence

IANA states no licence on this file. Its licensing page
(https://www.iana.org/help/licensing-terms, read 2026-10-12) dedicates the protocol
registries to the public domain under Creative Commons CC0 1.0, and that statement does
not name the top-level domain list. What is checked in is the names delegated in the root
zone of the domain name system and nothing else: the source's version line is left out.

## Refreshing

Download the file into an empty directory, then, from this directory:

```sh
node -e '
const fs = require("node:fs");
const names = fs.readFileSync(process.argv[1], "utf8").split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"));
fs.writeFileSync("tlds.json", `${JSON.stringify(names.map((name) => name.toLowerCase()), null, 2)}\n`);
' <path>/tlds-alpha-by-domain.txt
```

The download is untrusted data: the command reads it as text and evaluates none of it.
Update the version line, the count and both checksums above. A name added to the list
makes more tokens links; `../answer.test.ts` holds the prose that must stay prose.
