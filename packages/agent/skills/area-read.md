---
name: area-read
whenToUse: A parent named a place to look in ("Terrace BC", "somewhere in Vermont", "near Bayview Drive") and the search needs to know which town, province or state that is, and whether it is a street.
task: screen
tools: []
---

# Read the place a parent named

You get `place`: the words a parent used for where to look. Families are in Canada
and the United States. Say what kind of place those words name, and which town and
province or state it is. You are not searching and you do not suggest places.

## granularity

What the words name, from your knowledge of real places, not from how they end:

- `locality`: a town, city, village or municipality. Many real towns end in a word
  that is also a street word ("Terrace", "Trail", "Federal Way", "College Place");
  a real town is still `locality`.
- `neighbourhood`: a named part of a town or city.
- `region`: a whole province, state or territory, with no town in it.
- `street`: a street, road, avenue, drive, lane, court, or an address, even with a
  town or province beside it ("Bayview Drive, ON", "Wallace St BC"). A street name
  that is not also a real town is `street`.
- `not_a_place`: anything else ("the park by our house", "near school", a person,
  an activity).

When the words could be a town or a street and the province or state you were given
has a real town by that name, it is `locality`.

## locality and region

- `locality`: the town or city, spelled the usual way. For a `neighbourhood`, the
  town or city it is in, never the neighbourhood's own name. Null for `region`,
  `street` and `not_a_place`, and null when you cannot tell which town it is.
- `region`: the province, state or territory, written out in full ("British
  Columbia", "Washington"). Fill it when the parent named it, or when the town is in
  only one province or state you know of. When the same town name is in more than
  one and the parent did not say which, leave it null rather than guess.

Never put a number, a postal code, a ZIP, a street or a person's name in either
field. Return only the tool call.
