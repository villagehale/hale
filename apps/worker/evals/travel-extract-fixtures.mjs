// The travel-booking extraction — the corpus.
//
// This is the ONLY model call in the travel-brief lane, and nothing downstream re-checks
// its judgement: the city it writes is stored, exported to the family, and sent to a
// search engine; the `child_evidence` it writes is the whole of "Hale never briefs a solo
// work trip". So the quality claim is an eval, not a process commitment (rule #8), and it
// ships BEFORE the pass that calls it.
//
// The corpus is TWO-SIDED, and a one-sided one would make the product worse:
//
//   · A real family trip must come back with a city, two dates and the right evidence. A
//     confirmation that reads as nothing is silence for a family that IS going somewhere.
//
//   · A restaurant booking, a concert ticket and a solo work trip must come back EMPTY or
//     `none`. Every one of them reached the model because a two-token filter thought it
//     might be travel, and every one of them must end in nothing being said.
//
// Expected values are what a human reading the email would conclude (rule #7), never what
// the model happened to produce. `region` is asserted only where the email states it
// plainly — the skill says not to infer one, and requiring it everywhere would grade the
// opposite of the instruction.
//
// `expect.city` may be an ARRAY where a place has more than one correct English/French
// spelling: grading "Quebec City" as wrong because the fixture author typed "Québec" would
// measure the author, not the model. And where `city` is null the DATES ARE NOT ASSERTED -
// a null city already ends the trip downstream (`no_destination`), so requiring the model
// to also suppress dates it can plainly see would grade something the product never reads.
//
// `forbidInOutput` is asserted against the whole serialised answer, not a field list, so a
// confirmation number cannot escape by landing in a field nobody thought to check. On top
// of it, EVERY fixture is checked for a 6+ digit run in any returned field — the
// confirmation-number guard, asserted mechanically.

export const TRAVEL_EXTRACT_FIXTURES = [
  // ── real family trips: the city, the dates, and why Hale may speak ─────────
  {
    id: 'airline-named-child',
    subject: 'Your itinerary for AC 704',
    from: 'Air Canada <noreply@aircanada.ca>',
    receivedAt: '2026-09-01T14:12:00.000Z',
    childFirstNames: ['Mia', 'Leo'],
    body: [
      'AIR CANADA - ELECTRONIC TICKET ITINERARY',
      '',
      'AC 704  Toronto Pearson (YYZ) -> New York LaGuardia (LGA)',
      'Departs Sat 12 Sep 2026 07:45   Arrives 09:10',
      '',
      'AC 711  New York LaGuardia (LGA) -> Toronto Pearson (YYZ)',
      'Departs Tue 15 Sep 2026 18:20   Arrives 20:05',
      '',
      'Passengers:',
      '  CHEN/SARAH MS        Seat 14A',
      '  CHEN/MIA MISS        Seat 14B',
      '',
      'Booking reference: QRT4LM',
      'Total charged: CAD 812.44',
    ].join('\n'),
    expect: {
      city: 'New York',
      start: '2026-09-12',
      end: '2026-09-15',
      childEvidence: 'named_traveller',
    },
    forbidInOutput: ['QRT4LM', '812', 'CHEN', 'Air Canada', '14A'],
    why: 'The flagship shape. A passenger line names a household child, so Hale may speak.',
  },
  {
    id: 'airline-child-fare-unnamed',
    subject: 'Booking confirmed - your flight to Halifax',
    from: 'WestJet <confirmations@westjet.com>',
    receivedAt: '2026-10-02T09:00:00.000Z',
    childFirstNames: ['Mia', 'Leo'],
    body: [
      'Your WestJet booking is confirmed.',
      '',
      'Outbound: Toronto (YYZ) to Halifax (YHZ), departing Friday 23 October 2026, 08:15',
      'Return: Halifax (YHZ) to Toronto (YYZ), departing Monday 26 October 2026, 17:40',
      '',
      'Travellers: 1 adult, 1 child',
      'Fare total: $604.00 CAD',
      'Reservation code: 4KP2WQ',
    ].join('\n'),
    expect: {
      city: 'Halifax',
      start: '2026-10-23',
      end: '2026-10-26',
      childEvidence: 'child_fare',
    },
    forbidInOutput: ['4KP2WQ', '604', 'WestJet'],
    why: 'No name anywhere, but the itinerary COUNTS a child. The other half of the rule.',
  },
  {
    id: 'hotel-guest-count-infant',
    subject: 'Reservation confirmed at The Alt Hotel',
    from: 'reservations@althotel.example',
    receivedAt: '2026-06-11T20:00:00.000Z',
    childFirstNames: ['Noah'],
    body: [
      'Thank you for your reservation.',
      '',
      'Check-in:  Thursday, July 9, 2026 after 3:00 PM',
      'Check-out: Sunday, July 12, 2026 by 11:00 AM',
      "Property: The Alt Hotel, 125 Water Street, St. John's, Newfoundland and Labrador",
      '',
      'Occupancy: 2 adults, 1 infant (crib requested)',
      'Nightly rate: $349.00',
      'Confirmation number: 8842019',
    ].join('\n'),
    expect: {
      city: ["St. John's", 'St Johns', 'Saint Johns'],
      start: '2026-07-09',
      end: '2026-07-12',
      childEvidence: 'child_fare',
    },
    forbidInOutput: ['8842019', 'Water Street', 'Alt Hotel'],
    why: 'A hotel that counts an infant. The city is the municipality the property is in, never the property and never its street.',
  },
  {
    id: 'airbnb-named-child',
    subject: 'Reservation confirmed - your stay in Mont-Tremblant',
    from: 'Airbnb <automated@airbnb.example>',
    receivedAt: '2026-11-30T11:30:00.000Z',
    childFirstNames: ['Mia', 'Leo'],
    body: [
      'Your reservation is confirmed.',
      '',
      'Mont-Tremblant, Quebec',
      'Check-in: Fri, Jan 8, 2027',
      'Checkout: Mon, Jan 11, 2027',
      '',
      'Guests: Sarah, Daniel, Leo',
      'Total (3 nights): CAD 1,245.00',
      'Confirmation code: HMQX4RTP9',
    ].join('\n'),
    expect: {
      city: 'Mont-Tremblant',
      region: 'Quebec',
      start: '2027-01-08',
      end: '2027-01-11',
      childEvidence: 'named_traveller',
    },
    forbidInOutput: ['HMQX4RTP9', '1,245', 'Sarah', 'Daniel', 'Leo'],
    why: 'A guest list naming a household child, and a stay that crosses a YEAR BOUNDARY - the email prints 2027 and a naive "next occurrence" would answer 2026.',
  },
  {
    id: 'scarborough-hotel-is-toronto',
    subject: 'Your stay at Delta Hotels Toronto East',
    from: 'no-reply@marriott.example',
    receivedAt: '2026-09-20T13:00:00.000Z',
    childFirstNames: ['Mia'],
    body: [
      'Reservation confirmed.',
      '',
      'Delta Hotels by Marriott Toronto East',
      '2035 Kennedy Road, Scarborough, ON M1T 3G2',
      '',
      'Arrival: October 3, 2026',
      'Departure: October 5, 2026',
      'Room: 1 King, 2 adults 1 child',
      'Confirmation: 76104488',
    ].join('\n'),
    expect: {
      city: 'Toronto',
      region: 'Ontario',
      start: '2026-10-03',
      end: '2026-10-05',
      childEvidence: 'child_fare',
    },
    forbidInOutput: ['76104488', '2035', 'Kennedy', 'Delta', 'Marriott', 'M1T'],
    why: 'THE MUNICIPALITY, not the district. This is the model half of the away rule: get "Scarborough" here and a Toronto family is told they are in Scarborough. HOME_METRO is the deterministic half behind it.',
  },
  {
    id: 'french-confirmation',
    subject: 'Confirmation de réservation - votre séjour à Québec',
    from: 'reservations@hotelquebec.example',
    receivedAt: '2026-08-14T10:00:00.000Z',
    childFirstNames: ['Mia', 'Leo'],
    body: [
      'Votre réservation est confirmée.',
      '',
      'Hôtel du Vieux-Port, Québec, QC',
      'Arrivée : le 4 septembre 2026',
      'Départ : le 7 septembre 2026',
      '',
      'Occupants : 2 adultes, 2 enfants',
      'Numéro de confirmation : 5591027',
      'Total : 1 140,00 $',
    ].join('\n'),
    expect: {
      city: ['Québec', 'Quebec City', 'Ville de Québec'],
      start: '2026-09-04',
      end: '2026-09-07',
      childEvidence: 'child_fare',
    },
    forbidInOutput: ['5591027', 'Vieux-Port', '140,00'],
    why: 'The lane is outbound-first and English-only, but the INPUT is whatever the provider sent. A French confirmation is a trip.',
  },
  {
    id: 'flight-to-toronto',
    subject: 'e-Ticket receipt - your trip to Toronto',
    from: 'Porter Airlines <itinerary@flyporter.example>',
    receivedAt: '2026-05-04T16:45:00.000Z',
    childFirstNames: ['Mia'],
    body: [
      'PORTER AIRLINES - E-TICKET',
      '',
      'PD 128  Ottawa (YOW) -> Toronto Billy Bishop (YTZ)',
      'Depart Friday 22 May 2026, 16:30',
      'PD 145  Toronto Billy Bishop (YTZ) -> Ottawa (YOW)',
      'Depart Sunday 24 May 2026, 19:15',
      '',
      'Passengers: RIVERA/ANA, RIVERA/MIA (child)',
      'Booking ref: PW77QK',
    ].join('\n'),
    expect: {
      city: 'Toronto',
      start: '2026-05-22',
      end: '2026-05-24',
      childEvidence: 'named_traveller',
    },
    forbidInOutput: ['PW77QK', 'RIVERA', 'Porter'],
    why: 'A REAL city, correctly extracted. Whether Toronto is far enough from home to be worth a text is R1’s job and not the model’s - reading it accurately is the whole task here.',
  },
  {
    id: 'train-named-child',
    subject: 'Your VIA Rail itinerary',
    from: 'VIA Rail <noreply@viarail.example>',
    receivedAt: '2026-03-02T08:20:00.000Z',
    childFirstNames: ['Leo'],
    body: [
      'Train 64  Toronto Union -> Montreal Central',
      'Departs Thursday, March 19, 2026 at 09:22',
      'Train 67  Montreal Central -> Toronto Union',
      'Departs Sunday, March 22, 2026 at 15:40',
      '',
      'Travellers: PARK/JUNE (adult), PARK/LEO (youth)',
      'Confirmation: 3049117',
      'Amount: $318.00',
    ].join('\n'),
    expect: {
      city: 'Montreal',
      start: '2026-03-19',
      end: '2026-03-22',
      childEvidence: 'named_traveller',
    },
    forbidInOutput: ['3049117', '318', 'PARK', 'VIA Rail'],
    why: 'Not a flight and not a hotel. The destination is where they go, never Union Station.',
  },

  // ── real trips with NO child evidence: read correctly, and left alone ──────
  {
    id: 'corporate-solo-flight',
    subject: 'Your itinerary is confirmed',
    from: 'Egencia <no-reply@egencia.example>',
    receivedAt: '2026-04-06T07:10:00.000Z',
    childFirstNames: ['Mia', 'Leo'],
    body: [
      'Trip booked through your company travel programme.',
      '',
      'UA 538  Toronto (YYZ) -> Chicago O’Hare (ORD), Tue 21 Apr 2026, 06:55',
      'UA 621  Chicago O’Hare (ORD) -> Toronto (YYZ), Thu 23 Apr 2026, 20:10',
      '',
      'Traveller: CHEN/SARAH',
      'Cost centre: 44120',
      'Record locator: KX9PLM',
    ].join('\n'),
    expect: { city: 'Chicago', start: '2026-04-21', end: '2026-04-23', childEvidence: 'none' },
    forbidInOutput: ['KX9PLM', '44120', 'CHEN', 'Egencia'],
    why: 'THE ONE THE WHOLE FEATURE TURNS ON. A real trip, read perfectly, with no sign a child is on it - so nothing is stored and nothing is ever said. `none` is the right answer far more often than the other two.',
  },
  {
    id: 'hotel-two-adults',
    subject: 'Reservation confirmed - Hotel Bonaventure',
    from: 'reservations@bonaventure.example',
    receivedAt: '2026-02-09T12:00:00.000Z',
    childFirstNames: ['Mia'],
    body: [
      'Check-in: Wednesday, February 25, 2026',
      'Check-out: Friday, February 27, 2026',
      'Hotel Bonaventure, Montreal, QC',
      '',
      'Room type: 1 King. Occupancy: 2 adults.',
      'Confirmation number: 2290641',
    ].join('\n'),
    expect: { city: 'Montreal', start: '2026-02-25', end: '2026-02-27', childEvidence: 'none' },
    forbidInOutput: ['2290641', 'Bonaventure'],
    why: 'Two adults is not evidence of a child. A hotel with two beds is not evidence of a child. The bar for speaking is the booking SAYING so.',
  },
  {
    id: 'one-way-solo',
    subject: 'Flight confirmation - one way',
    from: 'Flair <bookings@flyflair.example>',
    receivedAt: '2026-07-01T05:00:00.000Z',
    childFirstNames: ['Noah'],
    body: [
      'F8 302  Toronto (YYZ) -> Vancouver (YVR)',
      'Departing Wednesday, 15 July 2026 at 06:20',
      'One-way. 1 passenger.',
      'Booking reference: TQ84RN',
    ].join('\n'),
    expect: { city: 'Vancouver', start: '2026-07-15', end: null, childEvidence: 'none' },
    forbidInOutput: ['TQ84RN', 'Flair'],
    why: 'A one-way booking has no return, and the skill is told not to guess one. A null end date is an honest answer; downstream it is `no_dates` and nothing is written.',
  },

  // ── not trips at all: the hard negatives the pre-filter let through ────────
  {
    id: 'restaurant-reservation',
    subject: 'Your reservation is confirmed - Alo',
    from: 'OpenTable <reservations@opentable.example>',
    receivedAt: '2026-05-18T19:00:00.000Z',
    childFirstNames: ['Mia'],
    body: [
      'Alo Restaurant',
      '163 Spadina Avenue, 3rd floor, Toronto',
      'Thursday, May 21, 2026 at 8:00 PM',
      'Party of 4',
      'Confirmation: 7710294',
    ].join('\n'),
    expect: { city: null, childEvidence: 'none' },
    forbidInOutput: ['7710294', 'Spadina', 'Alo'],
    why: 'A dinner table is not a trip. It carries a booking noun, a date, a city and a party size, which is exactly why it is here: every signal but the one that matters.',
  },
  {
    id: 'concert-ticket',
    subject: 'Your e-ticket for Massey Hall',
    from: 'Ticketmaster <orders@ticketmaster.example>',
    receivedAt: '2026-09-03T15:00:00.000Z',
    childFirstNames: ['Leo'],
    body: [
      'Your order is confirmed.',
      '',
      'Event: The Weather Station, Massey Hall, Toronto',
      'Saturday 26 September 2026, doors 7:00 PM',
      '2 tickets, Orchestra row K, seats 14-15',
      'Order number: 40-33019/TOR',
    ].join('\n'),
    expect: { city: null, childEvidence: 'none' },
    forbidInOutput: ['33019', 'Massey', 'Weather Station', 'row K'],
    why: 'An e-ticket that is not travel. "Doors" and a venue and a seat number, and nowhere to go.',
  },
  {
    id: 'rental-car-no-city',
    subject: 'Your rental car reservation',
    from: 'Enterprise <no-reply@enterprise.example>',
    receivedAt: '2026-08-01T10:00:00.000Z',
    childFirstNames: ['Mia'],
    body: [
      'Thank you for booking with us.',
      '',
      'Vehicle: Intermediate SUV',
      'Pick-up:  August 14, 2026 10:00 AM',
      'Drop-off: August 18, 2026 10:00 AM',
      'Location: Airport counter, Terminal 1',
      'Confirmation: 1099234',
    ].join('\n'),
    expect: { city: null, childEvidence: 'none' },
    forbidInOutput: ['1099234', 'Terminal 1', 'Enterprise'],
    why: 'A rental with no city anywhere in it. "Terminal 1" is not a destination, and inventing one from an airport counter is the failure this fixture exists to catch.',
  },
];
