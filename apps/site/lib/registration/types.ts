import type { HeadlineSegment } from '~/components/words-pull-up';
import type { FaqItem } from '~/lib/faq/index';

export interface DateRow {
  when: string;
  what: string;
}

export interface OfficialUrl {
  href: string;
  label: string;
}

export interface RuleCard {
  tag: string;
  title: string;
  line: string;
  checks: string[];
  linkHref?: string;
  linkLabel?: string;
}

export interface GuideGroup {
  title: string;
  items: string[];
}

export interface GuideSection {
  id: string;
  headline: HeadlineSegment[];
  lede?: string;
  paragraphs: string[];
  bullets?: string[];
  groups?: GuideGroup[];
  links?: OfficialUrl[];
}

export interface RegistrationGuide {
  slug: string;
  path: string;
  title: string;
  description: string;
  eyebrow: string;
  h1: HeadlineSegment[];
  lede: string;
  updated: string;
  placement: string;
  datesEyebrow: string;
  datesHeading: HeadlineSegment[];
  dateRows: DateRow[];
  dateNote: string;
  officialUrls: OfficialUrl[];
  unofficialNote: string;
  rulesEyebrow: string;
  rulesHeading: HeadlineSegment[];
  ruleCards: RuleCard[];
  sections: GuideSection[];
  faqs: FaqItem[];
  ctaHeading: string;
  ctaSub: string;
  footerNote: string;
}
