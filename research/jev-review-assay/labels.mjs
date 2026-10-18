// Label vocabularies and the explicit, non-1:1 mapping between Jev candidate
// labels and OpenRecord human judgments. Research-only; nothing here writes a
// judgment or is imported by hosted code.

export const LABEL_MAPPING_VERSION = 'jev-openrecord-label-map-v1'

export const JEV_A = Object.freeze(['SUPPORTS', 'CONTRADICTS', 'NOT_ADDRESSED', 'AMBIGUOUS'])
export const JEV_B = Object.freeze(['SUPPORTS', 'CONTRADICTS', 'DOES_NOT_ADDRESS'])
// OpenRecord `RecordDecision` (packages/db/src/record.ts), copied, not imported.
export const OPENRECORD = Object.freeze(['MATCHES', 'CONTRADICTS', 'UNKNOWN'])

// Many-to-one. OpenRecord has no NOT_ADDRESSED or AMBIGUOUS decision; both are
// UNKNOWN for comparison purposes. The reverse direction is undefined: a human
// UNKNOWN cannot be split into NOT_ADDRESSED vs AMBIGUOUS without a separate
// human sub-label (`unknownReason`). A human MATCHES may also correspond to a
// Jev AMBIGUOUS when the answer agrees on the main value but not the full scope
// of the fact, so the two vocabularies are not semantically identical even
// where the names coincide. Abstention is never mapped to UNKNOWN: a missing
// candidate is a coverage loss, not a correct "uncertain" prediction.
export const JEV_A_TO_OPENRECORD = Object.freeze({
  SUPPORTS: 'MATCHES',
  CONTRADICTS: 'CONTRADICTS',
  NOT_ADDRESSED: 'UNKNOWN',
  AMBIGUOUS: 'UNKNOWN',
})

export const UNKNOWN_REASONS = Object.freeze(['NOT_ADDRESSED', 'AMBIGUOUS', 'OTHER'])

export function toOpenRecord(jevLabel) {
  if (jevLabel === null || jevLabel === undefined) return null
  const mapped = JEV_A_TO_OPENRECORD[jevLabel]
  if (!mapped) throw Object.assign(new Error('UNMAPPED_LABEL'), { errorClass: 'UNMAPPED_LABEL' })
  return mapped
}

// A four-class reference label exists only when the human recorded MATCHES,
// CONTRADICTS, or UNKNOWN with an explicit NOT_ADDRESSED/AMBIGUOUS reason.
// Otherwise the item can only be scored in the collapsed OpenRecord space.
export function fourClassReference(decision, unknownReason) {
  if (decision === 'MATCHES') return 'SUPPORTS'
  if (decision === 'CONTRADICTS') return 'CONTRADICTS'
  if (decision === 'UNKNOWN' && (unknownReason === 'NOT_ADDRESSED' || unknownReason === 'AMBIGUOUS')) return unknownReason
  return null
}

// Fact-level aggregation mirrors OpenRecord's slot verdict rule
// (packages/db/src/record-view.ts): any CONTRADICTS wins, then any UNKNOWN,
// unanimous MATCHES otherwise. If any sample lacks a candidate the fact is
// incomplete and the result is null (never aggregated optimistically).
export function aggregateFact(decisions) {
  if (decisions.length === 0 || decisions.some(d => d === null)) return null
  if (decisions.includes('CONTRADICTS')) return 'CONTRADICTS'
  if (decisions.includes('UNKNOWN')) return 'UNKNOWN'
  return 'MATCHES'
}

// Historical Rust corpora (research/jev-assay) use different label sets. This
// mapping is used only to reuse their synthetic rows as engineering material.
export const HISTORICAL_A_TO_JEV = Object.freeze({
  SUPPORTED: 'SUPPORTS',
  CONTRADICTED: 'CONTRADICTS',
  INSUFFICIENT_EVIDENCE: 'NOT_ADDRESSED',
  PARTIAL: 'AMBIGUOUS',
  AMBIGUOUS: 'AMBIGUOUS',
})
export const HISTORICAL_B_TO_JEV = Object.freeze({
  SUPPORTS: 'SUPPORTS',
  CONTRADICTS: 'CONTRADICTS',
  AMBIGUOUS: 'DOES_NOT_ADDRESS',
  INSUFFICIENT: 'DOES_NOT_ADDRESS',
})
