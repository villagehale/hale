/**
 * The hand-VERIFIED curated resources seed — public local family programs
 * (EarlyON centres, public-library kids' programs, splash pads, public-health
 * lines) across the GTA/Halton regions Hale serves. Every entry was verified by a
 * human against the live source; nothing here is LLM-generated (honesty-first).
 * This list is the single source of truth for the seed — do NOT extend or invent
 * entries. `sortOrder` is the index so the rail's order is stable.
 */

export interface CuratedResourceSeed {
  name: string;
  category: string;
  area: string;
  url: string;
  description: string;
}

export const CURATED_RESOURCES: readonly CuratedResourceSeed[] = [
  {
    name: 'Halton Region – EarlyON Child and Family Centres',
    category: 'EarlyON child & family centres',
    area: 'Halton Region (serves Halton Hills, Milton, Oakville, Burlington)',
    url: 'https://www.halton.ca/for-residents/children-and-parenting/earlyon-child-and-family-centres',
    description:
      "Halton Region's directory of free EarlyON programs for families with children from prenatal to 6 years old, listing the provider for each municipality (Links2Care serves Halton Hills).",
  },
  {
    name: 'Links2Care – EarlyON Child and Family Centres',
    category: 'EarlyON child & family centres',
    area: 'Georgetown & Acton (Halton Hills)',
    url: 'https://links2care.ca/program/earlyon-child-family-centres/',
    description:
      'Free drop-in and registered EarlyON programs for children from birth to their 6th birthday and their caregivers, at three Georgetown sites and three Acton sites.',
  },
  {
    name: "Halton Hills Public Library – Children's Programs",
    category: "Public library children's programs",
    area: 'Georgetown & Acton (Halton Hills)',
    url: 'https://www.hhpl.ca/childrens-programs',
    description:
      'Children’s programming at both library branches, including early literacy, the Summer Reading Challenge, Reading Buddies, book clubs, Battle of the Books, and science and tech programs.',
  },
  {
    name: 'Town of Halton Hills – Recreation Programs',
    category: 'Community/recreation centres',
    area: 'Halton Hills',
    url: 'https://www.haltonhills.ca/en/explore-and-play/program-registration.aspx',
    description:
      "Registration hub for the Town's recreation programs, including swimming lessons, camps, skating, fitness, and children's programs, with online and in-person registration options.",
  },
  {
    name: 'Town of Halton Hills – Splash Pads',
    category: 'Parks & splash pads',
    area: 'Georgetown & Acton (Halton Hills)',
    url: 'https://www.haltonhills.ca/en/explore-and-play/splash-pads.aspx',
    description:
      "Lists the town's three splash pads — Dominion Gardens Park and Eighth Line Park in Georgetown and Prospect Park in Acton — open daily 10 a.m. to 8 p.m. from Victoria Day weekend to Labour Day weekend.",
  },
  {
    name: 'Halton Region – Breastfeeding',
    category: 'Public health',
    area: 'Halton Region',
    url: 'https://www.halton.ca/for-residents/children-and-parenting/breastfeeding',
    description:
      "Halton Region Public Health's breastfeeding hub covering getting started, common challenges, expressing and storing milk, and local supports including the Halton Breastfeeding Connection, with nurse access via 311.",
  },
  {
    name: 'Halton Region – Immunization',
    category: 'Public health',
    area: 'Halton Region',
    url: 'https://www.halton.ca/for-residents/immunizations-preventable-disease/immunization',
    description:
      "Halton Region Public Health's immunization page covering school-required vaccines, community catch-up clinics for students in Grades 2 to 12, and immunization records via the ICON portal.",
  },
  {
    name: 'City of Toronto – EarlyON Child and Family Centres',
    category: 'EarlyON child & family centres',
    area: 'Toronto',
    url: 'https://www.toronto.ca/community-people/children-parenting/children-programs-activities/child-family-programs-and-groups/child-family-programs/',
    description:
      "City page for Toronto's free EarlyON programs for children from birth to six years, with an address-searchable map of centres and Indigenous-led, francophone, Black-focused, and LGBTQ+-focused options.",
  },
  {
    name: 'Toronto Public Library – Programs for Kids & Families',
    category: "Public library children's programs",
    area: 'Toronto',
    url: 'https://tpl.ca/programs-and-classes/programs-for-kids-families/',
    description:
      "TPL's children's programming page covering storytimes, Ready for Reading early-literacy programs for under-5s, Leading to Reading tutoring, after-school clubs, and STEM/coding workshops for ages 6-12.",
  },
  {
    name: 'City of Toronto – Drop-in Water Play',
    category: 'Parks & splash pads',
    area: 'Toronto',
    url: 'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/swim-water-activities/drop-in-water-play/',
    description:
      "City page for Toronto's seasonal splash pads (daily 9 a.m. to 9 p.m., mid-May to mid-September) and supervised wading pools, with a searchable map of locations and schedules.",
  },
  {
    name: 'City of Toronto – Breastfeeding Clinics',
    category: 'Public health',
    area: 'Toronto',
    url: 'https://www.toronto.ca/community-people/children-parenting/pregnancy-and-parenting/breastfeeding/services/breastfeeding-clinics/',
    description:
      "Toronto Public Health's list of ten free breastfeeding clinic locations offering individual consultations with public health nurses and hospital staff, generally by appointment.",
  },
  {
    name: 'City of Toronto – Immunization',
    category: 'Public health',
    area: 'Toronto',
    url: 'https://www.toronto.ca/community-people/health-wellness-care/health-programs-advice/immunization/',
    description:
      "Toronto Public Health's immunization hub covering preschool vaccines for infants and young children, school-based clinics for grades 7 and 8, catch-up vaccination for students, and Ontario's publicly funded schedule.",
  },
  {
    name: 'Region of Peel – EarlyON Child and Family Centres',
    category: 'EarlyON child & family centres',
    area: 'Peel Region (Mississauga, Brampton, Caledon)',
    url: 'https://peelregion.ca/children-parenting/earlyon-child-family-centres',
    description:
      "Peel Region's page for free EarlyON programs for families with children 6 years and younger, including French-language services and Indigenous-led programs, with an EarlyON resource consultant phone line.",
  },
  {
    name: 'Region of Peel – Baby feeding support services',
    category: 'Public health',
    area: 'Peel Region (Brampton & Mississauga)',
    url: 'https://peelregion.ca/services/baby-feeding-support-services',
    description:
      "Peel Public Health's free baby-feeding supports: telephone consultations with public health nurses, in-person home visits, and referral-based clinic appointments in Brampton and Mississauga.",
  },
  {
    name: 'Mississauga Library – Storytimes and early literacy',
    category: "Public library children's programs",
    area: 'Mississauga',
    url: 'https://www.mississauga.ca/library/research-and-learn/education/early-literacy/',
    description:
      "Mississauga Library's page on drop-in storytimes and early-literacy activities (talking, singing, reading, writing, and playing) for young children and their caregivers.",
  },
  {
    name: 'City of Mississauga – Find a park',
    category: 'Parks & splash pads',
    area: 'Mississauga',
    url: 'https://www.mississauga.ca/events-and-attractions/parks/find-a-park/?Amenities=Spray+Pad',
    description:
      "Interactive finder for Mississauga's 500+ parks that filters by amenity, including the city's free spray pads.",
  },
  {
    name: 'City of Brampton – Community Centres',
    category: 'Community/recreation centres',
    area: 'Brampton',
    url: 'https://www.brampton.ca/EN/residents/Recreation/Community-Centres',
    description:
      "Directory of Brampton's 30+ recreation and community centres with links to registered programs including camps for ages 4-17, swimming lessons, and seasonal free drop-in swims.",
  },
  {
    name: 'Oakville Parent-Child Centre – Free EarlyON Programs',
    category: 'EarlyON child & family centres',
    area: 'Oakville',
    url: 'https://www.op-cc.ca/parented-programs/free-earlyon-programs.html',
    description:
      'Free drop-in EarlyON programs six days a week (including evenings and weekends) for caregivers of children from newborn to under 6, at sites across Oakville including a new North Oakville location.',
  },
  {
    name: 'ROCK (Reach Out Centre for Kids) – Locations List',
    category: 'EarlyON child & family centres',
    area: 'Burlington',
    url: 'https://rockonline.ca/locations/',
    description:
      "Locations page for ROCK, Burlington's EarlyON provider, listing the EarlyON Cumberland (710 Cumberland Ave.) and EarlyON St. Mark (2145 Upper Middle Rd.) centres with phone numbers.",
  },
  {
    name: 'Milton Community Resource Centre – EarlyON',
    category: 'EarlyON child & family centres',
    area: 'Milton',
    url: 'https://mcrc.on.ca/earlyon/',
    description:
      'Free drop-in EarlyON programming for caregivers and children from birth to 6 years old at locations across Milton, based at 410 Bronte Street South.',
  },
  {
    name: 'York Region – EarlyON Child and Family Programs',
    category: 'EarlyON child & family centres',
    area: 'York Region (Vaughan, Markham, Richmond Hill and area)',
    url: 'https://www.york.ca/support/childrens-services/earlyon-child-and-family-centres',
    description:
      "York Region's page for free EarlyON programs for children from birth to six years, with more than 70 program locations comprising 10 centres and over 60 mobile sites.",
  },
] as const;
