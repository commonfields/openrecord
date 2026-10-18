// Pure metric arithmetic over (reference, prediction) pairs. These functions
// cannot establish label provenance; callers must pass only genuine, frozen
// human labels for any real claim. A null prediction is an abstention or an
// unavailable decision: it is never credited as a correct "uncertain" answer.

export const METRICS_VERSION = 'jev-shadow-metrics-v1'
export const ABSTAIN = 'ABSTAIN'
export const HIGH_CONFIDENCE = 0.9

const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null })

// Wilson score interval (95%). n is the number of independent units supplied
// by the caller, which should be the cluster count for clustered data.
export function wilson(successes, n, z = 1.959964) {
  if (!n) return null
  const p = successes / n
  const denom = 1 + z * z / n
  const centre = (p + z * z / (2 * n)) / denom
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

function validate(pairs, labels) {
  for (const p of pairs) {
    if (!labels.includes(p.reference)) throw Object.assign(new Error('INVALID_METRIC_INPUT'), { errorClass: 'INVALID_METRIC_INPUT' })
    if (p.predicted !== null && !labels.includes(p.predicted)) throw Object.assign(new Error('INVALID_METRIC_INPUT'), { errorClass: 'INVALID_METRIC_INPUT' })
    if (p.probability !== undefined && p.probability !== null && !(p.probability >= 0 && p.probability <= 1)) throw Object.assign(new Error('INVALID_METRIC_INPUT'), { errorClass: 'INVALID_METRIC_INPUT' })
  }
}

export function confusionMatrix(pairs, labels) {
  validate(pairs, labels)
  const cols = [...labels, ABSTAIN]
  const m = Object.fromEntries(labels.map(r => [r, Object.fromEntries(cols.map(c => [c, 0]))]))
  for (const p of pairs) m[p.reference][p.predicted ?? ABSTAIN]++
  return { rows: 'reference', columns: 'predicted', labels: cols, matrix: m }
}

// Per-class precision is over emitted predictions; recall keeps abstentions in
// the denominator (an abstained positive is a missed positive).
export function perClass(pairs, labels) {
  validate(pairs, labels)
  return Object.fromEntries(labels.map(label => {
    const tp = pairs.filter(p => p.reference === label && p.predicted === label).length
    const fp = pairs.filter(p => p.reference !== label && p.predicted === label).length
    const fn = pairs.filter(p => p.reference === label && p.predicted !== label).length
    const precision = ratio(tp, tp + fp), recall = ratio(tp, tp + fn)
    const f1 = precision.value !== null && recall.value !== null && precision.value + recall.value > 0
      ? 2 * precision.value * recall.value / (precision.value + recall.value) : (tp + fp + fn ? 0 : null)
    return [label, { support: tp + fn, tp, fp, fn, precision, recall, f1 }]
  }))
}

// Macro F1 over reference classes that have support. Classes with zero support
// are listed and excluded rather than silently counted as 0 or 1.
export function macroF1(per) {
  const supported = Object.entries(per).filter(([, s]) => s.support > 0)
  const missing = Object.entries(per).filter(([, s]) => s.support === 0).map(([l]) => l)
  if (supported.length === 0) return { value: null, classes: [], excludedNoSupport: missing }
  const value = supported.reduce((a, [, s]) => a + (s.f1 ?? 0), 0) / supported.length
  return { value, classes: supported.map(([l]) => l), excludedNoSupport: missing }
}

// Multi-class Brier score over full probability vectors, and expected
// calibration error over the selected-label probability. Only computed when the
// predictor supplies probabilities (the deterministic baseline does not).
export function calibration(pairs, labels, bins = 10) {
  const scored = pairs.filter(p => p.predicted !== null && p.probabilities)
  if (scored.length === 0) return { supported: false, n: 0, brier: null, ece: null, bins: [] }
  const brier = scored.reduce((acc, p) => acc + labels.reduce((s, l) => {
    const y = p.reference === l ? 1 : 0
    return s + ((p.probabilities[l] ?? 0) - y) ** 2
  }, 0), 0) / scored.length
  const table = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, meanConfidence: 0, accuracy: 0 }))
  for (const p of scored) {
    const conf = p.probabilities[p.predicted]
    const b = table[Math.min(bins - 1, Math.floor(conf * bins))]
    b.n++; b.meanConfidence += conf; b.accuracy += p.predicted === p.reference ? 1 : 0
  }
  let ece = 0
  for (const b of table) {
    if (!b.n) continue
    b.meanConfidence /= b.n; b.accuracy /= b.n
    ece += (b.n / scored.length) * Math.abs(b.accuracy - b.meanConfidence)
  }
  return { supported: true, n: scored.length, brier, ece, bins: table.filter(b => b.n) }
}

export function percentile(xs, pct) {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((pct / 100) * v.length) - 1))]
}

// Independent units. Repeated observations of one fact are not independent;
// the conservative effective n is the number of distinct facts (ICC = 1), the
// optimistic bound is the observation count (ICC = 0).
export function effectiveSampleSize(items) {
  const facts = new Set(items.map(i => i.factId)), businesses = new Set(items.map(i => i.businessId))
  return { observations: items.length, facts: facts.size, businesses: businesses.size,
    conservativeEffectiveN: facts.size, optimisticEffectiveN: items.length }
}

// Observation-level interval and a conservative clustered interval whose n is
// the number of distinct facts behind the denominator (proportion preserved).
export function clusteredInterval(successes, n, denominatorPairs) {
  if (!n) return { observationLevel: null, factClustered: null, clusters: 0 }
  const clusters = new Set(denominatorPairs.map(p => p.factId)).size
  return { observationLevel: wilson(successes, n), factClustered: wilson((successes / n) * clusters, clusters), clusters }
}

/**
 * pairs: { reference, predicted|null, probability?, probabilities?, factId, businessId,
 *          latencyMs?, costUsd?, costKnown? }
 * positive: the class whose false positives are dangerous (CONTRADICTS).
 */
export function evaluate(pairs, labels, { positive = 'CONTRADICTS' } = {}) {
  validate(pairs, labels)
  const per = perClass(pairs, labels)
  const decided = pairs.filter(p => p.predicted !== null)
  const correct = decided.filter(p => p.predicted === p.reference).length
  const high = decided.filter(p => p.probability !== undefined && p.probability !== null && p.probability >= HIGH_CONFIDENCE)
  const hcfp = high.filter(p => p.predicted === positive && p.reference !== positive)
  const n = effectiveSampleSize(pairs)
  const costs = pairs.map(p => p.costUsd)
  const costKnown = pairs.length > 0 && pairs.every(p => p.costKnown === true && typeof p.costUsd === 'number')
  const pos = per[positive]
  return {
    metricsVersion: METRICS_VERSION,
    items: pairs.length,
    sampleSize: n,
    confusion: confusionMatrix(pairs, labels),
    perClass: per,
    macroF1: macroF1(per),
    accuracyOnDecided: ratio(correct, decided.length),
    coverage: ratio(decided.length, pairs.length),
    abstentionRate: ratio(pairs.length - decided.length, pairs.length),
    highConfidence: {
      threshold: HIGH_CONFIDENCE,
      decisions: high.length,
      wrong: high.filter(p => p.predicted !== p.reference).length,
      falsePositives: { class: positive, count: hcfp.length, ofHighConfidencePositives: high.filter(p => p.predicted === positive).length },
    },
    positivePrecisionInterval95: pos ? clusteredInterval(pos.tp, pos.tp + pos.fp, pairs.filter(p => p.predicted === positive)) : null,
    positiveRecallInterval95: pos ? clusteredInterval(pos.tp, pos.tp + pos.fn, pairs.filter(p => p.reference === positive)) : null,
    calibration: calibration(pairs, labels),
    costPerItemUsd: costKnown ? costs.reduce((a, b) => a + b, 0) / pairs.length : null,
    costBasis: costKnown ? 'PROVIDER_REPORTED' : 'UNKNOWN',
    latencyMs: { p50: percentile(pairs.map(p => p.latencyMs), 50), p95: percentile(pairs.map(p => p.latencyMs), 95) },
  }
}
