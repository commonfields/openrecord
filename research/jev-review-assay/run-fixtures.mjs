import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { cases } from './fixtures.mjs'
import { PROTOCOL, QUESTIONS, digest, runOfflineCase } from './assay.mjs'
import { BASELINE_VERSION, baselineA, baselineB, baselineClaimVsFacts } from './baseline.mjs'
import { JEV_A, JEV_B, OPENRECORD, LABEL_MAPPING_VERSION, aggregateFact, toOpenRecord } from './labels.mjs'
import { evaluate } from './metrics.mjs'
import { PROTOCOL_VERSION, RequestBudget, applyPolicy, driftCheck, groupedSplit, liveReadiness, referenceReadiness, selectThreshold, splitOf } from './protocol.mjs'
import { factCentricA, factCentricB, historicalA, historicalB } from './corpus.mjs'

// A unique directory prevents accidental overwrite or mixing of assay runs.
// There are intentionally no credential, model, live, or customer-data flags.
if (process.argv.length > 3 || process.argv[2]?.startsWith('-')) {
  console.error('Usage: node run-fixtures.mjs [new-output-directory]')
  process.exit(2)
}
const out = resolve(process.argv[2] ?? new URL('./reports/latest', import.meta.url).pathname)
const SALT = 'openrecord-jev-shadow-split-v1'
const FIXTURE_MODEL = 'offline-jev-fixture-v1'
const receipts = []

// ── Phase 1: adapter contract cases (authored responses) ───────────────────
const contract = []
for (const row of cases) contract.push(await runOfflineCase(row.input, row.fixture))
const mismatches = contract.filter((r, i) => (r.decision?.choice ?? r.errorClass) !== cases[i].expected)
receipts.push(...contract.map(r => ({ phase: 'contract', ...r })))

// ── Phase 2: deterministic baseline on SYNTHETIC corpora ───────────────────
const bySplit = (rows, manifest) => ({ dev: rows.filter(r => splitOf(manifest, r) === 'dev'), holdout: rows.filter(r => splitOf(manifest, r) === 'holdout') })
const score = (rows, labels) => evaluate(rows, labels)

const histA = historicalA().map(r => {
  const b = baselineClaimVsFacts(r)
  return { ...r, predicted: b.label, abstainReason: b.abstain }
})
const histAManifest = groupedSplit(histA, { salt: SALT })
const histB = historicalB().map(r => {
  const b = baselineB(r)
  return { ...r, predicted: b.label, abstainReason: b.abstain }
})
const histBManifest = groupedSplit(histB, { salt: SALT })

const fcA = factCentricA().map(r => {
  const b = baselineA({ factText: r.input.fact.text, answer: r.input.answer })
  return { ...r, baseline4: b.label, baselineOR: b.label ? toOpenRecord(b.label) : null, abstainReason: b.abstain }
})
const fcAManifest = groupedSplit(fcA, { salt: SALT })
const fcB = factCentricB().map(r => {
  const b = baselineB(r.input)
  return { ...r, baseline: b.label, abstainReason: b.abstain }
})
const fcBManifest = groupedSplit(fcB, { salt: SALT })

const perCategory = rows => Object.fromEntries([...new Set(rows.map(r => r.category ?? r.slot))].sort().map(c => {
  const sub = rows.filter(r => (r.category ?? r.slot) === c)
  return [c, { n: sub.length, correct: sub.filter(r => r.predicted === r.reference).length, abstained: sub.filter(r => r.predicted === null).length,
    falseContradicts: sub.filter(r => r.predicted === 'CONTRADICTS' && r.reference !== 'CONTRADICTS').length }]
}))
const orPairs = rows => rows.map(r => ({ ...r, predicted: r.baselineOR }))
const fourPairs = rows => rows.filter(r => r.reference4).map(r => ({ ...r, reference: r.reference4, predicted: r.baseline4 }))
const factLevel = rows => {
  const facts = new Map()
  for (const r of rows) {
    const f = facts.get(r.factId) ?? { factId: r.factId, businessId: r.businessId, refs: [], preds: [] }
    f.refs.push(r.reference); f.preds.push(r.predicted); facts.set(r.factId, f)
  }
  return [...facts.values()].map(f => ({ factId: f.factId, businessId: f.businessId, reference: aggregateFact(f.refs), predicted: aggregateFact(f.preds) }))
}
const preservedB = rows => rows.filter(r => r.reference !== 'SOURCE_NOT_PRESERVED').map(r => ({ ...r, predicted: r.baseline }))
const notPreservedB = rows => rows.filter(r => r.reference === 'SOURCE_NOT_PRESERVED')

const baseline = {
  material: 'SYNTHETIC', version: BASELINE_VERSION,
  caveat: 'Constructed cases only. The baseline author had seen the generator templates, so synthetic holdout scores are not an unbiased estimate and are not real-world accuracy.',
  historicalTaskA: {
    semantics: 'claim-centric (historical research/jev-assay rows; labels mapped SUPPORTED->SUPPORTS, CONTRADICTED->CONTRADICTS, PARTIAL->AMBIGUOUS, INSUFFICIENT_EVIDENCE->NOT_ADDRESSED)',
    split: histAManifest, dev: score(bySplit(histA, histAManifest).dev, JEV_A), holdout: score(bySplit(histA, histAManifest).holdout, JEV_A),
    perCategoryAll: perCategory(histA),
  },
  historicalTaskB: {
    semantics: 'historical citation rows; AMBIGUOUS and INSUFFICIENT both map to DOES_NOT_ADDRESS',
    split: histBManifest, dev: score(bySplit(histB, histBManifest).dev, JEV_B), holdout: score(bySplit(histB, histBManifest).holdout, JEV_B),
    perCategoryAll: perCategory(histB),
  },
  factCentricTaskA: {
    semantics: 'fact-centric, repeated observations per fact (OpenRecord-shaped)',
    split: fcAManifest,
    holdoutOpenRecordSpace: score(orPairs(bySplit(fcA, fcAManifest).holdout), OPENRECORD),
    holdoutFourClass: score(fourPairs(bySplit(fcA, fcAManifest).holdout), JEV_A),
    holdoutFactLevelOpenRecordSpace: score(factLevel(orPairs(bySplit(fcA, fcAManifest).holdout)).filter(f => f.reference), OPENRECORD),
    perSlotAll: perCategory(orPairs(fcA)),
  },
  factCentricTaskB: {
    split: fcBManifest,
    holdoutPreservedSource: score(preservedB(bySplit(fcB, fcBManifest).holdout), JEV_B),
    sourceNotPreserved: { items: notPreservedB(fcB).length, abstained: notPreservedB(fcB).filter(r => r.baseline === null).length },
    perKindAll: perCategory(preservedB(fcB)),
  },
}

// ── Phase 3: harness pipeline exercise (AUTHORED PERTURBED ORACLE) ─────────
// The responder below derives its answer from the constructed reference label
// and perturbs it deterministically. It is NOT a model and its scores say
// nothing about Jev. It exists to drive real SDK request/response handling,
// receipts, the dev-only threshold policy, and holdout scoring end to end.
const h = id => createHash('sha256').update(`perturb:${id}`).digest()[0]
function authored(task, id, label) {
  const labels = Object.keys(QUESTIONS[task].criteria)
  const byte = h(id)
  let selected = label, p = 0.82
  if (byte < 26) { selected = labels[(labels.indexOf(label) + 1) % labels.length]; p = 0.93 }
  else if (byte < 52) p = 0.55
  const probabilities = Object.fromEntries(labels.map(l => [l, l === selected ? p : (1 - p) / (labels.length - 1)]))
  return { response: { model: FIXTURE_MODEL, usage: { input_tokens: null, output_tokens: null },
    answers: { review: { type: 'choice', choice: selected, confidence: p, probabilities } } } }
}

async function pipeline(rows, manifest, task, refKey) {
  const eligible = rows.filter(r => r[refKey])
  const budget = new RequestBudget(eligible.length, eligible.length)
  const pairs = []
  for (const r of eligible) {
    const rec = await runOfflineCase(r.input, authored(task, r.id, r[refKey]),
      { meta: { split: splitOf(manifest, r), businessId: r.businessId, factId: r.factId }, budget })
    // The full question is stored once in summary.questions; receipts keep its digest.
    const { question: _question, ...slim } = rec
    receipts.push({ phase: 'pipeline-exercise', responder: 'AUTHORED_PERTURBED_ORACLE', ...slim })
    pairs.push({ id: r.id, businessId: r.businessId, factId: r.factId, reference: r[refKey],
      predicted: rec.decision?.choice ?? null, probability: rec.decision ? rec.decision.probabilities[rec.decision.choice] : null,
      probabilities: rec.decision?.probabilities ?? null, latencyMs: rec.latencyMs, costKnown: false, costUsd: null })
  }
  const dev = pairs.filter(p => splitOf(manifest, p) === 'dev')
  const policy = selectThreshold(dev, manifest, { positive: 'CONTRADICTS', targetPrecision: 0.95 })
  const holdout = pairs.filter(p => splitOf(manifest, p) === 'holdout').map(p => applyPolicy(p, policy))
  const labels = task === 'A' ? JEV_A : JEV_B
  const holdoutRaw = pairs.filter(p => splitOf(manifest, p) === 'holdout')
  return { requestsUsed: budget.used, policy, holdoutRaw: evaluate(holdoutRaw, labels), holdoutAfterFrozenPolicy: evaluate(holdout, labels),
    drift: driftCheck(receipts.filter(r => r.phase === 'pipeline-exercise' && r.task === task)) }
}

const pipelineExercise = {
  responder: 'AUTHORED_PERTURBED_ORACLE', interpretation: 'NOT_A_MODEL_RESULT',
  material: 'SYNTHETIC', transport: 'SDK_FIXTURE', providerRequests: 0, providerCostUsd: 0,
  taskA: await pipeline(fcA, fcAManifest, 'A', 'reference4'),
  // URL-only rows have no preserved source: they are never sent and abstain locally.
  taskB: await pipeline(fcB.map(r => ({ ...r, refB: r.reference === 'SOURCE_NOT_PRESERVED' ? null : r.reference })), fcBManifest, 'B', 'refB'),
}

// ── Phase 4: gates ─────────────────────────────────────────────────────────
const status = JSON.parse(await readFile(new URL('./status/reference-status.json', import.meta.url), 'utf8'))
const live = JSON.parse(await readFile(new URL('./status/live-readiness.json', import.meta.url), 'utf8'))
// Best case for the gate: pretend every genuine label could sit in the holdout.
const asHoldout = s => ({ ...s, holdout: { observations: s.judged.observations, factsByClass: s.judged.factsByClass,
  businesses: s.judged.businesses, maxBusinessShareByClass: s.judged.maxBusinessShareByClass },
  dev: { observations: 0, factsByClass: {}, businesses: 0, maxBusinessShareByClass: {} } })
const refA = referenceReadiness(asHoldout(status.taskA))
const refB = referenceReadiness({ ...status.taskB, holdout: { factsByClass: {}, businesses: 0 }, dev: { factsByClass: {}, businesses: 0 } })
const liveGate = liveReadiness(live)
const verdict = !refA.ready ? 'JEV_ASSAY_BLOCKED_REFERENCE_LABELS' : !liveGate.ready ? 'JEV_ASSAY_BLOCKED_AUTHORIZATION' : 'JEV_ASSAY_PROTOCOL_READY'

const summary = {
  protocol: PROTOCOL, shadowProtocol: PROTOCOL_VERSION, labelMapping: LABEL_MAPPING_VERSION,
  corpusDigest: digest(cases), material: 'SYNTHETIC', transport: 'SDK_FIXTURE',
  questions: Object.fromEntries(Object.entries(QUESTIONS).map(([k, q]) => [k, { digest: digest(q), question: q }])),
  liveExecution: 'NOT_EXECUTED', providerRequests: 0, providerCostUsd: 0, genuineHumanLabels: 0,
  contract: { cases: cases.length, succeeded: contract.filter(r => r.status === 'OK').length,
    skipped: contract.filter(r => r.status === 'SKIPPED').length, errors: contract.filter(r => r.status === 'ERROR').length,
    contractMismatches: mismatches.length },
  contractMismatches: mismatches.length,
  // Real-label metrics: unavailable. A zero denominator is not a zero error rate.
  precision: { numerator: 0, denominator: 0, value: null },
  recall: { numerator: 0, denominator: 0, value: null },
  liveLatencyMs: null, liveCostPerItemUsd: null, humanReviewEffortSaved: null,
  baselineSynthetic: baseline,
  pipelineExercise,
  gates: { referenceLabels: { taskA: refA, taskB: refB }, live: liveGate },
  verdict,
  recommendation: 'DEFER',
  reason: 'Offline contracts and synthetic baseline only. No genuine contradiction or uncertainty labels, no preserved citation source content, no live authorization.',
}
await mkdir(out, { recursive: false })
await writeFile(join(out, 'receipts.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' })
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
const brief = {
  verdict, contractMismatches: mismatches.length, providerRequests: 0, genuineHumanLabels: 0,
  baselineHistoricalAHoldoutMacroF1: baseline.historicalTaskA.holdout.macroF1.value,
  baselineFactCentricAHoldoutMacroF1: baseline.factCentricTaskA.holdoutOpenRecordSpace.macroF1.value,
  referenceBlockersA: refA.blockers.length, liveBlockers: liveGate.blockers.length, out,
}
console.log(JSON.stringify(brief, null, 2))
if (mismatches.length) process.exitCode = 1
