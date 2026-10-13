# Postal area to city

`ca.json` and `us.json` say which city a postal area belongs to, for one reader:
`../place.ts`, which tells the off-topic web search a family's city and country when the
family's row has a postal code and no city. It is public postal geography, checked in. No
network call is made at runtime and no model is asked.

A table holds every area its sources have. Each area has one city, or one of two reasons
it has none:

- `-1`, **ambiguous**: the area covers more than one town.
- `-2`, **unmapped**: the rule below could not reduce it to one municipality.

An area that is in neither table is unmapped too. Nothing is guessed.

`cities` is also the list `../place.ts` checks a family's stored city against, so the
Canadian table holds the name of every incorporated municipality the names data base
lists, including the ones no postal area resolves to. The US table needs no addition: its
source names a city for every ZIP code.

## Shape

```json
{
  "codes": ["A1A", "..."],
  "cities": ["Abbotsford", "..."],
  "cityOf": [312, -1, -2],
  "regions": ["Alberta", "..."],
  "regionCodes": ["AB", "..."],
  "regionOf": [4, 4, 4],
  "sharedCities": [17, "..."],
  "sharedRegions": [[8, 10], "..."]
}
```

`codes` is sorted. `cityOf[i]` is the city of `codes[i]`: an index into `cities`, or `-1`
or `-2`. Canada is keyed by forward sortation area (the first three characters of a postal
code), the United States by five-digit ZIP code.

`regions` is every province or state by name, sorted, and `regionCodes[j]` is the postal
abbreviation of `regions[j]`. `regionOf[i]` is the province or state `codes[i]` is in: an
index into `regions`, or `-1` where the source names none. `sharedCities` lists, by index
into `cities`, every place name found in more than one province or state, and
`sharedRegions[k]` is the `regions` that `sharedCities[k]` is found in. See "Provinces and
states".

## Sources

Retrieved 2026-10-12. The publishers regenerate their files, so a later download has
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

### Statistics Canada boundaries

Two layers of Statistics Canada's public map service for the 2021 Census cartographic
boundary files, retrieved 2026-10-12 by `node build.mjs --fetch`:

https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer

| File | Layer | Rows | SHA-256 of the file `--fetch` wrote |
|---|---|---|---|
| `fsa-all.ndjson` | 14, `FSA - lfsa000b21s_e`: every forward sortation area, its id and province, no boundary | 1,643 | `eb9cf024bba8171f0089866dcc1c03863ebc80f4901bc15010d4ef562646c0ba` |
| `fsa-urban.ndjson` | 14 again: the boundary of every urban area (second character not `0`) | 1,462 | `709bbf2a0ff1396ab4f63f2c5f7a92cfe4dc35f6f40e4ef591697a01d1ac92bf` |
| `csd.ndjson` | 9, `CSD - lcsd000b21s_e`: the boundary, name and type of every census subdivision outside Nunavut | 5,130 | `31fa1b0bed067c4e4589df928c83681099a6d0c490ae77ab3ab900a97bb27d16` |

Each file is one row per line, as the service returned it, in the service's own row
order, with coordinates in its Lambert projection (EPSG:3347) to a tenth of a metre.

- **Complete.** The service is asked how many rows each query has before it is paged
  through, and `--fetch` fails unless that many distinct rows arrived. The counts above
  are the service's.
- **Retries.** The service answers HTTP 500 with an HTML error page now and then. A
  failed request is tried again after five seconds, eight times. A page it refuses as a
  query is asked for again at half the size.
- **Rural boundaries are not fetched.** A rural area is ambiguous by rule 1, so its
  boundary is never read, and each one is megabytes of coastline.
- **Nunavut's census subdivisions are not fetched.** The service cannot return its
  unorganized territories at all (one has 124,000 km of coastline). Nunavut has no urban
  area, and the build proves nothing was needed from there: for every urban area, the
  shares of its land in the subdivisions that were fetched sum to 1 (to thirteen decimal
  places in this build), and the build fails if any area's fall short by half a percent.

The larger boundary downloads on www12.statcan.gc.ca answer a plain request with a bot
challenge, which is why the map service is the source.

### Licences and attribution

- **GeoNames postal codes** (`CA.txt`, `US.txt`). Creative Commons Attribution 4.0, as
  the `readme.txt` in each download states. Credit: GeoNames, https://www.geonames.org.
- **Canadian Geographical Names Data Base** (`cgn_canada_csv_eng.csv`), Natural Resources
  Canada. Open Government Licence - Canada,
  https://open.canada.ca/en/open-government-licence-canada, as the dataset's metadata
  states. Contains information licensed under the Open Government Licence - Canada.
- **Statistics Canada boundary files** (the three `.ndjson` files). Statistics Canada
  Open Licence, https://www.statcan.gc.ca/en/terms-conditions/open-licence. The notice it
  requires on a product that contains the information: Adapted from Statistics Canada,
  Forward Sortation Area Boundary File and Census Subdivision Cartographic Boundary
  File, 2021 Census. This does not constitute an endorsement by Statistics Canada of this
  product.

All three licences allow copying, adapting and redistributing with this credit. `ca.json`
is adapted from all three sources and `us.json` from GeoNames, and they carry the same
credit.

## Villages, for a sensitive search

`coarsen.json` says which of those place names are official villages, and the nearest
city to send instead when a search is about a sensitive question (`../place.ts`,
`coarsenPlace`). A question that is not sensitive is sent the place as read, village
included. A town is never in this file.

A name is a village only when that is its best class in that province or state. In
Canada a city, a town or a municipal district (`CITY`, `TOWN`, `MUN1`, `MUN2`) beats
`VILG`. In the United States a city, a borough or a town (Census LSAD 25, 21, 43) beats
a village (LSAD 47). A census designated place (LSAD 57) is not a village and is not
read. The nearest city is the nearest `CITY` or LSAD 25 in the same province or state,
within 150 km. Farther than that, the file names no city and the search is sent the
province or state alone.

Built by `node coarsen.mjs <cgn_canada_csv_eng.csv> <2024_Gaz_place_national.txt>`. The
Canadian file is the same download as above. The United States file is the 2024 Census
Gazetteer national places file, retrieved 2026-10-13:

| File | From | SHA-256 |
|---|---|---|
| `2024_Gaz_place_national.txt` | https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip | `ba197a3c0cef828d47981ed7435d820d040d3199bf39a719cd9b11412c59afa6` |

The gazetteer is a work of the United States government. SHA-256 of `coarsen.json`:
`66660d512618afc9279b0a27b77d42981b6ef4063e9c6a8b005231cffacc7696`.

## Rebuilding

Unpack each GeoNames and names data base download into an empty directory of its own,
fetch the boundaries into another, then build:

```sh
node build.mjs --fetch <empty directory>
node build.mjs <path>/CA.txt <path>/US.txt <path>/cgn_canada_csv_eng.csv <that directory>
```

`--fetch` makes about a hundred requests and writes about 350 MB. The build writes `ca.json` and
`us.json` beside itself and prints the counts under "Coverage". From the downloads above
it rebuilds both files byte for byte:

- `ca.json`: `54c5737272a15e25ea045ada4552fed9338d142b1e8fb62212f2f2d01ac5adf4`
- `us.json`: `4460c3f926b1d79cf4c8a88c240d2dbc958919948e16bf2cb0f730ee17ebde3c`

`--review` as a fifth argument prints every Canadian area beside what it resolved to and
how its land divides, and writes nothing. The downloads are untrusted data: the script
reads them as text, evaluates none of it, and makes no network call outside `--fetch`.
It uses no geometry library and has no dependency.

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
4. **The names.** Take the description with any parenthesised part removed. The area
   resolves to a municipality when **all** of these hold:
   - the description is, or begins with, the name of an incorporated municipality of the
     same province in the Canadian Geographical Names Data Base, compared without case
     or accents. When more than one name fits, the longest (`North Vancouver`, not
     `Vancouver`; `Red Deer County`, not `Red Deer`);
   - that municipality's point is within 25 km of the area's point. This is what keeps
     `Mercier West` in Montréal from becoming the town of Mercier;
   - no other municipality whose own name contains this one's as a word is nearer.
     `Montreal East` is the town of Montréal-Est and `Kelowna West` is West Kelowna.

   The city is spelled as the names data base spells it (`Québec`, `Montréal`).
5. **The land**, for an area rule 4 could not place and the boundary file has. Most of
   these are named for a community, a district or a former borough inside a larger
   municipality (`Woodbridge`, `Kanata`, `Plateau Mont-Royal`), which no list of
   municipalities holds. The area's boundary is laid over the census subdivision
   boundaries, and:
   - when at least **95%** of its land lies in one census subdivision that is a
     municipality, the area resolves to that municipality, spelled as the boundary file
     spells it (the English name, where it gives two);
   - when no subdivision holds 95%, it is ambiguous: the area is split;
   - when the subdivision that holds 95% is not a municipality (a reserve, a settlement,
     unorganized territory, the unincorporated part of a county or regional district),
     it is unmapped;
   - when the description names a municipality and the land says a different one, it is
     unmapped. See "Why the land does not overrule the names".
6. Anything else: unmapped.

An area the postal source lists twice with two different results is ambiguous. Two rows
in it carry a full postal code in place of an area and are left out. An area only the
boundary file has (13 of them) is placed by rules 1 and 5.

"Incorporated municipality" in rule 4 is a record in the names data base's Populated Place
category coded `CITY`, `TOWN` or `VILG` and not a borough, or one coded `MUN1` or `MUN2`
whose kind is a county, district, regional, rural, resort, specialized or township
municipality. A community, a neighbourhood, a former municipality and a hamlet are none of
those. In rule 5 it is a census subdivision whose type is not one of the municipal
equivalents the 2021 Census Dictionary lists (`MUNICIPAL_EQUIVALENTS` in `build.mjs`).

#### Why 95%

The script was first written with 95%, before any boundary was fetched. The data was then
looked at, for the 427 areas rule 5 is applied to, and it stayed. The largest share of
each area's land that lies in one census subdivision:

| Largest share | Areas |
|---|---|
| 100% (to a twentieth of a percent) | 303 |
| 99% up to 100% | 11 |
| 95% up to 99% | 13 |
| 94% up to 95% | 0 |
| 90% up to 94% | 13 |
| below 90% | 87 |

The areas fall into two groups with a gap between them, and 95% sits at the gap: no area
is within a point below it, so the table is the same for any figure from 94% to 95%.
Above it an area has at most a twentieth of its land elsewhere, usually a sliver along a
shared boundary (`L4L`, Woodbridge: Vaughan 99.6%, Toronto 0.4%). Below it the second
municipality is a real part of the area (`L4A`, Stouffville: Whitchurch-Stouffville 90.3%,
Uxbridge 9.7%). No area was moved across it to make it come out one way or the other.

#### How the land is measured

`build.mjs` does it without a geometry library. An area is cut by 2,000 evenly spaced
horizontal lines. On each line, the stretch inside the area is compared with the stretch
inside every census subdivision whose bounding box touches the area; a stretch's length
times the spacing of the lines is land. The same input gives the same output on any
machine. Two checks run on every urban area and fail the build: the land measured this
way is within half a percent of the area the source states for it (it was within 0.012%
for all 1,462), and the shares sum to 1.

#### Why the land does not overrule the names

A census forward sortation area is drawn around wherever a household reported the code,
and a household outside town can have a box at the post office in town. So the boundary
of an area in the middle of a city can take in a great deal of country. `R3C` is downtown
Winnipeg, and 98% of its boundary is the rural municipality of Rosser. `T2P` is downtown
Calgary, and 98% of it is Rocky View County.

By land alone both would come out as the wrong municipality. So rule 4 is applied first
and its result stands whatever the land says: every area the names placed keeps the city
it had. And where rule 4 failed only on its distance test, so the description does name a
municipality, the land is believed only when it names the same one. That leaves `T2P`,
`T1B` (Medicine Hat South) and `S4A` (Estevan) unmapped rather than resolved to the
county around them. It also leaves six Montréal districts unmapped whose names are towns
elsewhere in Québec (`Mercier`, `Saint-Michel`, `Saint-Henri`, `Saint-Pierre`), and
`N3Y` (Simcoe, in Norfolk County).

### United States

1. A row with no state (military and diplomatic mail), or filed under the Marshall
   Islands: unmapped.
2. A ZIP code the source lists twice with two different places: ambiguous.
3. Otherwise the place as the source gives it.

### Provinces and states

A city and a country do not always name one place: `J1S` (Quebec) and `N8P` (Ontario) are
both `Windsor, Canada`. So each table also says which province or state an area is in, and
which place names more than one of them has. `../place.ts` sends the province or state
with a city only for such a name, and the name it sends is this table's.

- **Canada.** The thirteen names and abbreviations are fixed in `build.mjs`
  (`PROVINCES`), spelled as the names data base spells them. An area's province is the
  one the postal source lists it under, and Statistics Canada's for the 13 areas only the
  boundary file has. The two sources agree on every area both have, and the build fails
  if they stop agreeing.
- **United States.** A ZIP code's state is the one the postal source lists it under, by
  the name and abbreviation that source gives: the fifty states and the District of
  Columbia. A ZIP code with no state, or one listed under two, has none; it has no city
  either.
- **A place name is shared** when it is found in more than one province or state: an
  area in each resolves to it, or, in Canada, the names data base lists an incorporated
  municipality of that name there.

A name two places in the SAME province or state share is not told apart by this, and
neither is a postal city from a municipality of the same name.

## Coverage

| | Areas | One city | Ambiguous | Unmapped | Place names |
|---|---|---|---|---|---|
| Canada, before rule 5 | 1,651 | 1,042 (63.1%) | 190 | 419 | 396 |
| Canada | 1,664 | 1,340 (80.5%) | 290 | 34 | 3,423 |
| United States | 41,488 | 40,975 (98.8%) | 2 | 511 | 18,572 |

What rule 5 did with the 427 areas it was applied to (414 of the 419 the names left
unmapped, and 13 only the boundary file has): 298 resolve, 100 are ambiguous, 29 are
unmapped. No area that resolved before changed or stopped resolving.

Canada's 290 ambiguous areas are 185 rural ones, 5 the postal source describes as more
than one place, and 100 whose land is split. Its 34 unmapped areas are 19 whose land is
not in a municipality, 10 where the land contradicts the name, and 5 the boundary file
does not have. Urban areas that resolve, by first letter: `M` (Toronto) 102 of 102, `L`
(the rest of the Greater Toronto Area and central Ontario) 147 of 151, `K` (eastern
Ontario) 73 of 74, `H` (Montréal and Laval) 103 of 121.

The Canadian place names are the 450 some area resolves to and the rest of the names data
base's incorporated municipalities.

Shared names: 72 of Canada's 3,423 place names are found in more than one province
(`Windsor`, `Stratford`, `Woodstock`, `Kingston`, `Burlington`, `Victoria`), and 70 of its
1,340 resolved areas resolve to one of them. In the United States 4,019 of 18,572 place
names are found in more than one state (`Springfield`, `Denver`, `Portland`), and 22,657
of its 40,975 resolved ZIP codes resolve to one of them, so more than half carry their
state.

## What this does not know

- **Canada, one area in five.** A family in an unmapped or ambiguous area is asked which
  city, as every family was before this table.
- **Canada, where people live inside an area.** Rule 5 measures land. A town whose area
  reaches out along its rural routes is split by land although nearly everyone in it
  lives in the town: `L7J` (Acton) is Halton Hills 49.6%, Erin 38.2%, Milton 12.2%, and
  stays ambiguous. Telling those apart needs population by block, which is a different
  source. A hundred areas are ambiguous for this reason or because they really do
  straddle two towns, and the land cannot say which.
- **Canada, rule 5 naming the country around a town.** When a town is a municipality of
  its own, its area's land is mostly the municipality around it, and the description
  does not match the town's name in the names data base, rule 5 names the surrounding
  one. One is known: `N4X`, described as `St. Mary's`, resolves to Perth South (95.7%)
  and not to the town of St. Marys (4.3%).
- **Canada, areas the names placed that straddle a boundary.** An area named for one city
  can include a corner of the next one, and rule 4 stands whatever the land says. Of the
  1,030 areas the names placed that the boundary file has, the land puts 95% or more of
  57 in a different census subdivision. Three are one municipality spelled two ways.
  Nearly all the rest are a town whose area takes in the country around it (Okotoks,
  Medicine Hat, Winnipeg's `R3C`), where the name is right. For a handful the name is
  probably wrong: `L2V`, described as St. Catharines, lies wholly in Thorold, and `V3E`,
  described as Port Coquitlam, wholly in Coquitlam. The land shows a further 248 as
  split.
- **Canada, areas newer than 2021, and ones nobody lives in.** The boundary file is the
  2021 Census's. The postal source has 21 areas it does not, mostly office towers,
  government mail and an airport. They keep what rules 1 to 4 give them.
- **United States, postal city.** The place is the city of the postal address, which is
  not always the incorporated municipality: a borough of New York and a named district of
  Los Angeles each have a postal city of their own, and so does a military base. A ZIP
  code that straddles two municipalities has one postal city, so this source cannot mark
  it ambiguous.
- **Area points are estimates.** The 25 km test uses the postal source's own coordinates,
  and a few are far off. Those areas fail rule 4 and go to rule 5.

## Size and loading

`ca.json` is 75,405 bytes and `us.json` 965,965 bytes. `../place.ts` loads one with a
dynamic `import()` the first time a turn needs that country's table, and the module system
keeps it. Neither is loaded at start-up, on a turn with the search dark, for a question
that does not turn on where the family is, or for a family with neither a stored city nor
a postal area to look up (`../place.lazy.test.ts`).
