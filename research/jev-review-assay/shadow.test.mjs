// Tests for the deterministic baseline, label mapping, metrics, and protocol
// gates. All inputs are synthetic or fabricated arithmetic examples.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baselineA, baselineB, baselineClaimVsFacts, extractValues } from './baseline.mjs'
import { JEV_A, JEV_A_TO_OPENRECORD, OPENRECORD, aggregateFact, fourClassReference, toOpenRecord } from './labels.mjs'
import { calibration, confusionMatrix, effectiveSampleSize, evaluate, macroF1, perClass, wilson } from './metrics.mjs'
import { RequestBudget, applyPolicy, assertSplitIntegrity, driftCheck, groupedSplit, liveReadiness, referenceReadiness, selectThreshold, spendingBound, splitOf, summarizeLabels } from './protocol.mjs'
import { factCentricA, factCentricB, historicalA, historicalB } from './corpus.mjs'
import { readFile } from 'node:fs/promises'

const A = (factText, answer) => baselineA({ factText, answer }).label

test('baseline: exact money, currency, period, and ranges', () => {
  assert.equal(A('Plan costs USD 20 per month.', 'Plan costs $20 a month.'), 'SUPPORTS')
  assert.equal(A('Plan costs USD 20 per month.', 'Plan costs USD 10 per month.'), 'CONTRADICTS')
  assert.equal(A('Plan costs USD 20 per month.', 'Plan costs EUR 20 per month.'), 'AMBIGUOUS')
  assert.equal(A('Plan costs USD 20 per month.', 'Plan costs USD 20 per year.'), 'AMBIGUOUS')
  assert.equal(A('Plan costs USD 20 per month.', 'One source says USD 10, another USD 20 per month.'), 'AMBIGUOUS')
  assert.equal(A('Plan costs USD 20 per month.', 'The shop sells candles.'), 'NOT_ADDRESSED')
  assert.equal(A('Plan costs USD 1,250 per year.', 'Plan costs USD 1250 per year.'), 'SUPPORTS')
  assert.equal(A('Plan costs Rp 150.000 per month.', 'Plan costs IDR 150000 per month.'), 'SUPPORTS')
})

test('baseline: dates, durations, negation, and conditions', () => {
  assert.equal(A('The sale starts on October 25, 2026.', 'The sale starts on October 20, 2026.'), 'CONTRADICTS')
  assert.equal(A('The sale starts on October 25, 2026.', 'The sale starts October 25.'), 'SUPPORTS')
  assert.equal(A('The sale starts on October 25, 2026.', 'The sale starts in October 2026.'), 'AMBIGUOUS')
  assert.equal(A('The sale starts on October 25, 2026.', 'The sale does not start on October 25.'), 'CONTRADICTS')
  assert.equal(A('The sale starts on 2026-10-25.', 'The sale starts on 25 October 2026.'), 'SUPPORTS')
  assert.equal(A('Returns are accepted within 14 days.', 'Returns are possible within 2 weeks.'), 'SUPPORTS')
  assert.equal(A('Returns are accepted within 21 days.', 'Returns are accepted within 10-30 days.'), 'AMBIGUOUS')
  assert.equal(A('Returns are accepted within 21 days.', 'Returns are accepted within 30 days.'), 'CONTRADICTS')
  assert.equal(A('Acme offers a free plan.', 'Acme does not offer a free plan.'), 'CONTRADICTS')
  assert.equal(A('Acme offers a free plan.', 'Acme offers a free plan.'), 'SUPPORTS')
})

test('baseline abstains on qualitative facts and never treats a URL as source content', () => {
  const q = baselineA({ factText: 'The shop is family-owned.', answer: 'It is owned by a chain.' })
  assert.equal(q.label, null)
  assert.equal(q.abstain, 'NO_EXACT_VALUE_IN_FACT')
  assert.equal(baselineB({ claim: 'Pro costs USD 20.', sourceText: '' }).abstain, 'SOURCE_TEXT_MISSING')
  assert.equal(baselineB({ claim: 'Pro costs USD 20.', sourceText: 'https://example.invalid/pricing' }).abstain, 'URL_IS_NOT_SOURCE_CONTENT')
  assert.equal(baselineB({ claim: 'Pro costs USD 20 per month.', sourceText: 'Pro is USD 20 per month.' }).label, 'SUPPORTS')
  assert.equal(baselineB({ claim: 'Pro costs USD 20 per month.', sourceText: 'Pro is USD 29 per month.' }).label, 'CONTRADICTS')
  assert.equal(baselineB({ claim: 'Pro costs USD 20 per month and includes SSO.', sourceText: 'Pro is USD 20 per month.' }).label, 'DOES_NOT_ADDRESS')
})

test('baseline is deterministic and value extraction is literal', () => {
  const t = 'Plan costs USD 20 per month; launched March 2024; 1,234 active users; 15% off.'
  assert.deepEqual(extractValues(t), extractValues(t))
  const kinds = extractValues(t).map(v => v.kind)
  for (const k of ['money', 'date', 'quantity', 'percent']) assert.ok(kinds.includes(k), k)
  // Known limitation, kept visible: entity scope is not resolved.
  assert.equal(baselineClaimVsFacts({ claim: 'Acme costs $20 per month.', facts: ['Acmo (a different product) costs $9 per month.'] }).label, 'CONTRADICTS')
})

test('label mapping is explicit, many-to-one, and never maps abstention', () => {
  assert.deepEqual(Object.keys(JEV_A_TO_OPENRECORD).sort(), [...JEV_A].sort())
  assert.equal(toOpenRecord('NOT_ADDRESSED'), 'UNKNOWN')
  assert.equal(toOpenRecord('AMBIGUOUS'), 'UNKNOWN')
  assert.equal(toOpenRecord(null), null)
  assert.throws(() => toOpenRecord('MATCHES'), /UNMAPPED_LABEL/)
  for (const v of Object.values(JEV_A_TO_OPENRECORD)) assert.ok(OPENRECORD.includes(v))
  assert.equal(fourClassReference('UNKNOWN', null), null)
  assert.equal(fourClassReference('UNKNOWN', 'AMBIGUOUS'), 'AMBIGUOUS')
  assert.equal(aggregateFact(['MATCHES', 'CONTRADICTS', 'MATCHES']), 'CONTRADICTS')
  assert.equal(aggregateFact(['MATCHES', 'UNKNOWN']), 'UNKNOWN')
  assert.equal(aggregateFact(['MATCHES', null]), null)
})

test('metrics arithmetic (fabricated counts, not model results)', () => {
  const L = ['MATCHES', 'CONTRADICTS', 'UNKNOWN']
  const pairs = [
    { reference: 'CONTRADICTS', predicted: 'CONTRADICTS', probability: 0.95, factId: 'f1', businessId: 'b1' },
    { reference: 'CONTRADICTS', predicted: null, probability: null, factId: 'f1', businessId: 'b1' },
    { reference: 'MATCHES', predicted: 'CONTRADICTS', probability: 0.95, factId: 'f2', businessId: 'b1' },
    { reference: 'UNKNOWN', predicted: 'UNKNOWN', probability: 0.6, factId: 'f3', businessId: 'b2' },
  ]
  const per = perClass(pairs, L)
  assert.deepEqual(per.CONTRADICTS.precision, { numerator: 1, denominator: 2, value: 0.5 })
  assert.deepEqual(per.CONTRADICTS.recall, { numerator: 1, denominator: 2, value: 0.5 })
  assert.equal(per.MATCHES.f1, 0)
  assert.equal(confusionMatrix(pairs, L).matrix.CONTRADICTS.ABSTAIN, 1)
  const r = evaluate(pairs, L)
  assert.equal(r.coverage.value, 0.75)
  assert.equal(r.abstentionRate.value, 0.25)
  assert.equal(r.highConfidence.falsePositives.count, 1)
  assert.deepEqual(r.sampleSize, { observations: 4, facts: 3, businesses: 2, conservativeEffectiveN: 3, optimisticEffectiveN: 4 })
  assert.equal(r.costPerItemUsd, null)
  assert.equal(r.costBasis, 'UNKNOWN')
  assert.equal(r.calibration.supported, false)
  assert.equal(macroF1(perClass([], L)).value, null)
  assert.throws(() => evaluate([{ reference: 'SUPPORTS', predicted: null, factId: 'x', businessId: 'y' }], L), /INVALID_METRIC_INPUT/)
  const [lo, hi] = wilson(27, 30)
  assert.ok(lo > 0.73 && lo < 0.75 && hi > 0.96 && hi < 0.98)
  const cal = calibration([{ reference: 'A', predicted: 'A', probabilities: { A: 1, B: 0 } }], ['A', 'B'])
  assert.equal(cal.brier, 0)
  assert.equal(effectiveSampleSize([]).facts, 0)
})

test('split is by business, deterministic, and detects drift', () => {
  const rows = factCentricA()
  const m = groupedSplit(rows, { salt: 's' })
  assert.deepEqual(groupedSplit([...rows].reverse(), { salt: 's' }), m)
  assert.equal(m.dev.businesses.filter(b => m.holdout.businesses.includes(b)).length, 0)
  for (const fact of new Set(rows.map(r => r.factId))) {
    assert.equal(new Set(rows.filter(r => r.factId === fact).map(r => splitOf(m, r))).size, 1, fact)
  }
  assert.ok(assertSplitIntegrity(m, rows))
  assert.throws(() => assertSplitIntegrity(m, rows.slice(1)), /SPLIT_DRIFT/)
  assert.throws(() => groupedSplit([{ id: 'x', factId: 'f', businessId: 'a' }, { id: 'y', factId: 'f', businessId: 'b' }], { salt: 's' }), /FACT_SPANS_BUSINESSES/)
  assert.throws(() => groupedSplit(rows, {}), /SPLIT_SALT_REQUIRED/)
})

test('thresholds are selected on dev only and fail closed', () => {
  const rows = factCentricA()
  const m = groupedSplit(rows, { salt: 's' })
  const pair = (r, predicted, probability) => ({ ...r, reference: r.reference4 ?? 'AMBIGUOUS', predicted, probability })
  const holdoutRow = rows.find(r => splitOf(m, r) === 'holdout')
  assert.throws(() => selectThreshold([pair(holdoutRow, 'CONTRADICTS', 0.9)], m), /THRESHOLD_TUNING_ON_HOLDOUT/)
  const dev = rows.filter(r => splitOf(m, r) === 'dev')
  const perfect = dev.map(r => pair(r, r.reference4 ?? 'AMBIGUOUS', 0.9))
  const ok = selectThreshold(perfect, m)
  assert.equal(ok.met, true)
  assert.equal(ok.threshold, 0.5)
  assert.equal(ok.devDigest, m.dev.digest)
  assert.ok(Object.isFrozen(ok))
  const bad = dev.map(r => pair(r, 'CONTRADICTS', 0.99))
  const closed = selectThreshold(bad, m)
  assert.equal(closed.met, false)
  assert.equal(closed.threshold, null)
  assert.equal(applyPolicy(pair(holdoutRow, 'CONTRADICTS', 0.99), closed).predicted, null)
  assert.equal(applyPolicy(pair(holdoutRow, 'CONTRADICTS', 0.4), ok).abstainReason, 'BELOW_FROZEN_THRESHOLD')
})

test('reference readiness blocks the current genuine label status', async () => {
  const status = JSON.parse(await readFile(new URL('./status/reference-status.json', import.meta.url), 'utf8'))
  assert.equal(status.taskA.judged.decisions.CONTRADICTS, 0)
  const asHoldout = { ...status.taskA, holdout: status.taskA.judged, dev: { factsByClass: {}, businesses: 0 } }
  const r = referenceReadiness(asHoldout)
  assert.equal(r.ready, false)
  for (const b of ['HOLDOUT_CONTRADICTS_FACTS:0/30', 'HOLDOUT_UNKNOWN_FACTS:0/30', 'HOLDOUT_BUSINESSES:1/8', 'REVIEW_INCOMPLETE']) assert.ok(r.blockers.includes(b), b)
  // Synthetic material can never satisfy the gate, however large.
  const rows = factCentricA({ businesses: 26, samples: 5 })
  const m = groupedSplit(rows, { salt: 's' })
  const s = summarizeLabels(rows, m, 'A')
  const synth = referenceReadiness({ ...s, provenance: 'SYNTHETIC', synthetic: true, frozen: true, blindedToJev: true, reviewComplete: true })
  assert.equal(synth.ready, false)
  assert.ok(synth.blockers.includes('PROVENANCE_NOT_HUMAN:SYNTHETIC'))
  assert.ok(synth.blockers.includes('SYNTHETIC_OR_UNDECLARED_MATERIAL'))
})

test('live readiness, spending bound, request budget, and drift', async () => {
  const live = JSON.parse(await readFile(new URL('./status/live-readiness.json', import.meta.url), 'utf8'))
  const g = liveReadiness(live)
  assert.equal(g.ready, false)
  assert.equal(g.blockers.length, 7)
  assert.equal(liveReadiness({}).ready, false)
  assert.equal(spendingBound({ requests: 10, maxInputTokensPerRequest: 1000, maxOutputTokensPerRequest: 10, inputUsdPerMillion: null, outputUsdPerMillion: 1 }).status, 'COST_UNKNOWN_BLOCKS_PAID_EXECUTION')
  const b = spendingBound({ requests: 10, maxInputTokensPerRequest: 1_000_000, maxOutputTokensPerRequest: 0, inputUsdPerMillion: 2, outputUsdPerMillion: 4 })
  assert.equal(b.usd, 20)
  assert.throws(() => new RequestBudget(5, 6), /INSUFFICIENT_REQUEST_BUDGET/)
  assert.throws(() => new RequestBudget(0, 0), /INVALID_REQUEST_BUDGET/)
  const budget = new RequestBudget(1, 1); budget.consume()
  assert.throws(() => budget.consume(), /REQUEST_BUDGET_EXHAUSTED/)
  assert.equal(driftCheck([{ status: 'OK', observedModel: 'a' }, { status: 'OK', observedModel: 'b' }]).verdict, 'RUN_INVALIDATED_MODEL_DRIFT')
  assert.equal(driftCheck([{ status: 'OK', observedModel: 'a' }, { status: 'ERROR', observedModel: null }]).verdict, 'NO_DRIFT')
})

test('every corpus row is labelled synthetic and uses fictional names', () => {
  for (const r of [...historicalA(), ...historicalB(), ...factCentricA(), ...factCentricB()]) {
    assert.equal(r.labelOrigin, 'synthetic_constructed', r.id)
    assert.ok(r.businessId.startsWith('synthetic'), r.id)
    if (r.input) assert.equal(r.input.material, 'SYNTHETIC')
  }
  for (const r of factCentricB().filter(r => r.reference === 'SOURCE_NOT_PRESERVED')) {
    assert.equal(r.input.sourceText, '')
    assert.ok(r.citationUrl.endsWith('.invalid/source'))
  }
})
