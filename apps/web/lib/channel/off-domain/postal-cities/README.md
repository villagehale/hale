# Postal area to city

`ca.json` and `us.json` say which city a postal area belongs to, for one reader:
`../place.ts`, which tells the off-topic web search a family's city and country when the
family's row has a postal code and no city. It is public postal geography, checked in. No
network call is made at runtime and no model is asked.

A table holds every area its source has. Each area has one city, or one of two reasons it
has none:

- `-1`, **ambiguous**: the area covers more than one town.
- `-2`, **unmapped**: the rule below could not reduce it to one municipality.

An area that is in neither table is unmapped too. Nothing is guessed.

## Shape

```json
{ "codes": ["A1A", "..."], "cities": ["Abbotsford", "..."], "cityOf": [312, -1, -2] }
```

`codes` is sorted. `cityOf[i]` is the city of `codes[i]`: an index into `cities`, or `-1`
or `-2`. Canada is keyed by forward sortation area (the first three characters of a postal
code), the United States by five-digit ZIP code.

## Sources

Retrieved 2026-10-12. Both publishers regenerate their files, so a later download has
another checksum and may build a slightly different table.

| File | From | SHA-256 of the download |
|---|---|---|
| `CA.zip` (holds `CA.txt`) | https://download.geonames.org/export/zip/CA.zip | `f52db74d89d1df2473f9f6af2e62e3cf4af4c7cf26322ca0e1714b3b8a8a522d` |
| `US.zip` (holds `US.txt`) | https://download.geonames.org/export/zip/US.zip | `78562cd2f7865e7252581f1480a03280c9efa6d9490c7d7977f85a6f272a5ff6` |
| `cgn_canada_csv_eng.zip` (holds `cgn_canada_csv_eng.csv`) | https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_cgn_toponyme/prov_csv_eng/cgn_canada_csv_eng.zip | `9d53f69f3fe8fc975e82ac2606d57d3b3daca9b50587396796009add08ac40d8` |

SHA-256 of the three text files inside them, which are what the script reads:

- `CA.txt`: `0980e72da7c3c39a066dcad5cf6348adf72e4c7149aee204e7155cf6af8cd61b`
- `US.txt`: `88495471922bbafb1e982c01aafd1e38038d08dde578be2ec5bbc0f16bf9dc9e`
- `cgn_canada_csv_eng.csv`: `49125a94a87aae2affb257fdb5f97d209f1b103e4e094753d20216cb0bca19d8`

### Licences and attribution

- **GeoNames postal codes** (`CA.txt`, `US.txt`). Creative Commons Attribution 4.0, as
  the `readme.txt` in each download states. Credit: GeoNames, https://www.geonames.org.
- **Canadian Geographical Names Data Base** (`cgn_canada_csv_eng.csv`), Natural Resources
  Canada. Open Government Licence - Canada,
  https://open.canada.ca/en/open-government-licence-canada, as the dataset's metadata
  states. Contains information licensed under the Open Government Licence - Canada.

Both licences allow copying, adapting and redistributing with this credit. The two JSON
files are adapted from these sources and carry the same credit.

## Rebuilding

Unpack each download into an empty directory of its own, then:

```sh
node build.mjs <path>/CA.txt <path>/US.txt <path>/cgn_canada_csv_eng.csv
```

It writes `ca.json` and `us.json` beside itself and prints the counts under "Coverage".
`--review` as a fourth argument prints every Canadian area beside what it resolved to and
writes nothing. The downloads are untrusted data: the script reads them as text, evaluates
none of it and makes no network call.

## The rule

### What the source's place column holds

**United States.** One row per ZIP code, and the place is the city of that ZIP's postal
address: `Denver`, `Beverly Hills`, `Brooklyn`. Plain names, no descriptions.

**Canada.** One row per forward sortation area, and the place is a description written by
hand, not a municipality: `Downtown Toronto (Richmond / Adelaide / King)`, `North York
(Bayview Village)` (a former borough), `Mercier West` (a district of Montréal that shares
its name with a town 34 km away), `Eastern Alberta (St. Paul)` (a region), `Burlington
South`, `Rothesay, Quispamsis` (two towns). The other columns do not rescue it: the
second-order division is sometimes the city, sometimes a former borough, sometimes cut
short (`Sault Ste.`), and for North Vancouver it says `Vancouver`. So a Canadian place is
never used as written. It is checked against a second source that knows what a
municipality is.

### Canada

In order, for each forward sortation area:

1. **Rural** (second character `0`): ambiguous. A rural area covers many towns.
2. **First letter `M`**: Toronto. Canada Post's `M` district is the City of Toronto and
   nothing else. The source bears it out: each of its 102 `M` areas is described as
   Toronto, as one of its former boroughs (North York, Scarborough, Etobicoke, East York,
   York) or as a district inside them (Don Mills, Downsview, Willowdale, Weston).
3. **The description lists places with a comma** (`Rothesay, Quispamsis`): ambiguous.
4. Take the description with any parenthesised part removed. The area resolves to a
   municipality when **all** of these hold:
   - the description is, or begins with, the name of an incorporated municipality of the
     same province in the Canadian Geographical Names Data Base, compared without case
     or accents. When more than one name fits, the longest (`North Vancouver`, not
     `Vancouver`; `Red Deer County`, not `Red Deer`);
   - that municipality's point is within 25 km of the area's point. This is what keeps
     `Mercier West` in Montréal from becoming the town of Mercier;
   - no other municipality whose own name contains this one's as a word is nearer.
     `Montreal East` is the town of Montréal-Est and `Kelowna West` is West Kelowna.

   The city is spelled as the names data base spells it (`Québec`, `Montréal`).
5. Anything else: unmapped.

An area the source lists twice with two different results is ambiguous. Two rows in the
source carry a full postal code in place of an area and are left out.

"Incorporated municipality" is a record in the names data base's Populated Place category
coded `CITY`, `TOWN` or `VILG` and not a borough, or one coded `MUN1` or `MUN2` whose kind
is a county, district, regional, rural, resort, specialized or township municipality. A
community, a neighbourhood, a former municipality and a hamlet are none of those.

### United States

1. A row with no state (military and diplomatic mail), or filed under the Marshall
   Islands: unmapped.
2. A ZIP code the source lists twice with two different places: ambiguous.
3. Otherwise the place as the source gives it.

## Coverage

| | Areas | One city | Ambiguous | Unmapped | City names |
|---|---|---|---|---|---|
| Canada | 1,651 | 1,042 (63.1%) | 190 | 419 | 396 |
| United States | 41,488 | 40,975 (98.8%) | 2 | 511 | 18,572 |

Canada's 190 ambiguous areas are 185 rural ones and 5 the source describes as more than
one place. Its 419 unmapped areas are named for something that is not a municipality:
most of Montréal and Laval (named by district; 106 of the 121 urban areas whose code begins with `H`),
former municipalities and communities inside a larger one (Dartmouth, Kanata, Nepean,
Sherwood Park), and communities inside a town of another name (Georgetown in Halton
Hills, Bowmanville in Clarington, Thornhill, Maple and Woodbridge in Vaughan and
Markham).

## What this does not know

- **Canada, one third of areas.** A family in an unmapped or ambiguous area is asked which
  city, as every family was before this table. The sound way to close the gap is to
  overlay Statistics Canada's forward sortation area boundaries on its census subdivision
  boundaries (both under the Statistics Canada Open Licence), which gives the
  municipalities each area actually lies in.
- **Canada, areas that straddle a boundary.** An area named for one city can include a
  corner of the next one. The source does not say, and the rule cannot see it.
- **United States, postal city.** The place is the city of the postal address, which is
  not always the incorporated municipality: a borough of New York and a named district of
  Los Angeles each have a postal city of their own, and so does a military base. A ZIP
  code that straddles two municipalities has one postal city, so this source cannot mark
  it ambiguous.
- **Area points are estimates.** The 25 km test uses the source's own coordinates, and a
  few are far off. Those areas come out unmapped, never as another city.

## Size and loading

`ca.json` is 20,818 bytes and `us.json` 775,627 bytes. `../place.ts` loads one with a
dynamic `import()` the first time a turn needs that country's table, and the module system
keeps it. Neither is loaded at start-up, on a turn with the search dark, for a family with
a stored city, or for a question that does not turn on where the family is
(`../place.lazy.test.ts`).
