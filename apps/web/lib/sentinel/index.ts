/**
 * Public surface of the E2 sentinel — VIL-225. `classifyChildEventEmail` is the
 * library function E3 (the proactive change loop) calls per triage-worthy
 * envelope; everything else here is its supporting typed contract.
 */
export { classifyChildEventEmail, type ClassifyChildEventEmailDeps } from './pipeline';
export { loadCorrelationCandidates } from './candidates';
export { correlateExtraction, type CorrelationCandidate, type CorrelationInput } from './correlate';
export { fetchGmailMessageBody, BODY_RETENTION } from './fetch-body';
export type {
  CorrelatedEventRef,
  ExtractedEvent,
  ExtractionKind,
  FamilyChildRef,
  InboxEnvelope,
  SentinelClassification,
} from './types';
