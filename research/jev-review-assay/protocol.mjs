// Shadow-evaluation protocol mechanics: grouped split, frozen manifests,
// threshold selection restricted to development data, reference-label and
// live-readiness gates, request budget, and spending bound. Pure functions;
// no network, database, credential, or production import.
import { createHash } from 'node:crypto'

export const PROTOCOL_VERSION = 'openrecord-jev-shadow-protocol-v1'
const sha = s => createHash('sha256').update(s).digest('hex')
const fail = errorClass => { throw Object.assign(new Error(errorClass), { errorClass }) }

// ── Grouped split ───────────────────────────────────────────────────────────
// Split by business (facts nest inside businesses), never by observation.
// Businesses are ordered by a salted hash; the first ceil(k * fraction) go to
// holdout. Deterministic and independent of item order.
export function groupedSplit(items, { salt, holdoutFraction = 1 / 3 } = {}) {
  if (typeof salt !== 'string' || !salt) fail('SPLIT_SALT_REQUIRED')
  const factOwner = new Map()
  for (const i of items) {
    if (!i.businessId || !i.factId) fail('SPLIT_GROUP_MISSING')
    const owner = factOwner.get(i.factId)
    if (owner && owner !== i.businessId) fail('FACT_SPANS_BUSINESSES')
    factOwner.set(i.factId, i.businessId)
  }
  const businesses = [...new Set(items.map(i => i.businessId))]
    .sort((a, b) => sha(`${salt}:${a}`).localeCompare(sha(`${salt}:${b}`)))
  const k = businesses.length >= 2 ? Math.max(1, Math.min(businesses.length - 1, Math.ceil(businesses.length * holdoutFraction))) : 0
  const holdout = businesses.slice(0, k).sort(), dev = businesses.slice(k).sort()
  const ids = set => items.filter(i => set.includes(i.businessId)).map(i => i.id).sort()
  const manifest = {
    protocol: PROTOCOL_VERSION, groupBy: 'businessId', salt, holdoutFraction, frozen: true,
    dev: { businesses: dev, items: ids(dev).length, digest: sha(JSON.stringify(ids(dev))) },
    holdout: { businesses: holdout, items: ids(holdout).length, digest: sha(JSON.stringify(ids(holdout))) },
  }
  manifest.digest = sha(JSON.stringify({ ...manifest, digest: undefined }))
  return manifest
}

export function splitOf(manifest, item) {
  if (manifest.holdout.businesses.includes(item.businessId)) return 'holdout'
  if (manifest.dev.businesses.includes(item.businessId)) return 'dev'
  return null
}

export function assertSplitIntegrity(manifest, items) {
  const overlap = manifest.dev.businesses.filter(b => manifest.holdout.businesses.includes(b))
  if (overlap.length) fail('SPLIT_OVERLAP')
  const recomputed = groupedSplit(items, { salt: manifest.salt, holdoutFraction: manifest.holdoutFraction })
  if (recomputed.digest !== manifest.digest) fail('SPLIT_DRIFT')
  return true
}

// ── Threshold policy (dev only) ────────────────────────────────────────────
// A candidate is emitted only when the selected-label probability reaches the
// threshold; otherwise the item abstains to human review. The threshold is the
// smallest grid value whose dev precision on the dangerous class meets the
// target. Any holdout item in the input is a protocol violation.
export function selectThreshold(devPairs, manifest, { positive = 'CONTRADICTS', targetPrecision = 0.95, grid = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95] } = {}) {
  if (devPairs.some(p => splitOf(manifest, p) !== 'dev')) fail('THRESHOLD_TUNING_ON_HOLDOUT')
  let chosen = null
  const trace = []
  for (const t of grid) {
    const emitted = devPairs.filter(p => p.predicted === positive && p.probability >= t)
    const tp = emitted.filter(p => p.reference === positive).length
    const precision = emitted.length ? tp / emitted.length : null
    trace.push({ threshold: t, emitted: emitted.length, precision })
    if (chosen === null && precision !== null && precision >= targetPrecision) chosen = t
  }
  const policy = {
    // Fail closed: if no dev threshold meets the target, no candidate may be emitted.
    protocol: PROTOCOL_VERSION, positive, targetPrecision, threshold: chosen,
    met: chosen !== null, selectedOn: 'dev', devDigest: manifest.dev.digest, splitDigest: manifest.digest, trace,
  }
  policy.digest = sha(JSON.stringify({ ...policy, digest: undefined }))
  return Object.freeze(policy)
}

export function applyPolicy(pair, policy) {
  if (pair.predicted === null || pair.probability === null || pair.probability === undefined) return { ...pair, predicted: null }
  if (policy.threshold === null) return { ...pair, predicted: null, abstainReason: 'POLICY_TARGET_NOT_MET_ON_DEV' }
  return pair.probability >= policy.threshold ? pair : { ...pair, predicted: null, abstainReason: 'BELOW_FROZEN_THRESHOLD' }
}

// ── Reference-label readiness (preregistered minimums) ──────────────────────
// Rationale: with 30 independent facts in a class and observed rate 0.9, the
// 95% Wilson interval is roughly [0.74, 0.97]; fewer facts give intervals too
// wide to support an adoption decision. Business caps prevent one business
// from dominating a class.
export const REFERENCE_MINIMUMS_V1 = Object.freeze({
  A: Object.freeze({ classes: ['MATCHES', 'CONTRADICTS', 'UNKNOWN'], holdoutFactsPerClass: 30, devFactsPerClass: 10, holdoutBusinesses: 8, devBusinesses: 3, maxBusinessShare: 0.25 }),
  B: Object.freeze({ classes: ['SUPPORTS', 'CONTRADICTS', 'DOES_NOT_ADDRESS'], holdoutFactsPerClass: 30, devFactsPerClass: 10, holdoutBusinesses: 8, devBusinesses: 3, maxBusinessShare: 0.25 }),
})

// Summarize item-level labels into counts of distinct facts per class (a fact
// counts toward every class it has at least one human label for).
export function summarizeLabels(items, manifest, task) {
  const classes = REFERENCE_MINIMUMS_V1[task].classes
  const part = split => {
    const rows = items.filter(i => manifest ? splitOf(manifest, i) === split : true)
    const factsByClass = Object.fromEntries(classes.map(c => [c, new Set(rows.filter(r => r.reference === c).map(r => r.factId)).size]))
    const maxBusinessShareByClass = Object.fromEntries(classes.map(c => {
      const facts = rows.filter(r => r.reference === c)
      const perBiz = {}
      for (const biz of new Map(facts.map(r => [r.factId, r.businessId])).values()) perBiz[biz] = (perBiz[biz] ?? 0) + 1
      const total = Object.values(perBiz).reduce((a, b) => a + b, 0)
      return [c, total ? Math.max(...Object.values(perBiz)) / total : null]
    }))
    return { observations: rows.length, factsByClass, businesses: new Set(rows.map(r => r.businessId)).size, maxBusinessShareByClass }
  }
  return { task, dev: part('dev'), holdout: part('holdout') }
}

export function referenceReadiness(summary) {
  const min = REFERENCE_MINIMUMS_V1[summary.task]
  const blockers = []
  if (summary.provenance !== 'HUMAN') blockers.push(`PROVENANCE_NOT_HUMAN:${summary.provenance}`)
  if (summary.synthetic !== false) blockers.push('SYNTHETIC_OR_UNDECLARED_MATERIAL')
  if (summary.frozen !== true) blockers.push('REFERENCE_SET_NOT_FROZEN')
  if (summary.blindedToJev !== true) blockers.push('REVIEWERS_NOT_BLINDED_OR_UNDECLARED')
  if (summary.reviewComplete !== true) blockers.push('REVIEW_INCOMPLETE')
  for (const [split, need, needBiz] of [['holdout', min.holdoutFactsPerClass, min.holdoutBusinesses], ['dev', min.devFactsPerClass, min.devBusinesses]]) {
    const s = summary[split]
    if (!s) { blockers.push(`${split.toUpperCase()}_MISSING`); continue }
    for (const c of min.classes) if ((s.factsByClass?.[c] ?? 0) < need) blockers.push(`${split.toUpperCase()}_${c}_FACTS:${s.factsByClass?.[c] ?? 0}/${need}`)
    if ((s.businesses ?? 0) < needBiz) blockers.push(`${split.toUpperCase()}_BUSINESSES:${s.businesses ?? 0}/${needBiz}`)
    for (const c of min.classes) {
      const share = s.maxBusinessShareByClass?.[c]
      if (share !== null && share !== undefined && share > min.maxBusinessShare) blockers.push(`${split.toUpperCase()}_${c}_BUSINESS_SHARE:${share.toFixed(2)}>${min.maxBusinessShare}`)
    }
  }
  return { ready: blockers.length === 0, minimums: min, blockers }
}

// ── Live readiness ──────────────────────────────────────────────────────────
export const LIVE_REQUIREMENTS = Object.freeze([
  'API_CONTRACT_VERIFIED', 'MODEL_IDENTITY_PINNED', 'PRICING_VERIFIED', 'CREDENTIAL_SCOPE_VERIFIED',
  'EVIDENCE_TRANSMISSION_PERMITTED', 'SPENDING_BOUND_COMPUTED', 'OWNER_APPROVAL_RECORDED',
])

export function liveReadiness(checklist) {
  const blockers = LIVE_REQUIREMENTS.filter(k => checklist?.[k]?.status !== 'VERIFIED').map(k => `${k}:${checklist?.[k]?.status ?? 'MISSING'}`)
  return { ready: blockers.length === 0, blockers }
}

// Upper bound in USD. UTF-8 bytes bound tokens from above for any byte-level
// tokenizer; the provider's own tokenizer must still be confirmed. Unknown
// prices block paid execution rather than defaulting to zero.
export function spendingBound({ requests, maxInputTokensPerRequest, maxOutputTokensPerRequest, inputUsdPerMillion, outputUsdPerMillion, perRequestUsd = 0 }) {
  if (!Number.isSafeInteger(requests) || requests < 1) fail('INVALID_REQUEST_COUNT')
  const prices = [inputUsdPerMillion, outputUsdPerMillion, maxOutputTokensPerRequest]
  if (prices.some(p => typeof p !== 'number' || !Number.isFinite(p) || p < 0)) return { usd: null, status: 'COST_UNKNOWN_BLOCKS_PAID_EXECUTION' }
  const usd = requests * ((maxInputTokensPerRequest * inputUsdPerMillion + maxOutputTokensPerRequest * outputUsdPerMillion) / 1e6 + perRequestUsd)
  return { usd, status: 'BOUNDED' }
}

// One request per eligible case; the plan must fit the cap before any request
// (partial benchmarks are refused, as in the historical Rust harness).
export class RequestBudget {
  constructor(maxRequests, plannedRequests) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) fail('INVALID_REQUEST_BUDGET')
    if (plannedRequests > maxRequests) fail('INSUFFICIENT_REQUEST_BUDGET')
    this.max = maxRequests; this.used = 0
  }
  consume() { if (this.used >= this.max) fail('REQUEST_BUDGET_EXHAUSTED'); this.used++ }
}

// Every receipt in a run must report the same provider model; otherwise the
// run is invalid (historical RUN_INVALIDATED_MODEL_DRIFT rule).
export function driftCheck(receipts) {
  const models = [...new Set(receipts.filter(r => r.status === 'OK').map(r => r.observedModel))]
  return { observedModels: models, verdict: models.length > 1 ? 'RUN_INVALIDATED_MODEL_DRIFT' : 'NO_DRIFT' }
}
