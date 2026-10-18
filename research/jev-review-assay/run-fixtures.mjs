import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cases } from './fixtures.mjs'
import { PROTOCOL, digest, runOfflineCase } from './assay.mjs'

// A unique directory prevents accidental overwrite or mixing of assay runs.
// There are intentionally no credential, model, live, or customer-data flags.
if (process.argv.length > 3 || process.argv[2]?.startsWith('-')) {
  console.error('Usage: node run-fixtures.mjs [new-output-directory]')
  process.exit(2)
}
const out = resolve(process.argv[2] ?? new URL('./reports/latest', import.meta.url).pathname)
const receipts = []
for (const row of cases) receipts.push(await runOfflineCase(row.input, row.fixture))
const mismatches = receipts.filter((r, i) => (r.decision?.choice ?? r.errorClass) !== cases[i].expected)
const summary = {
  protocol: PROTOCOL, corpusDigest: digest(cases), material: 'SYNTHETIC', transport: 'SDK_FIXTURE',
  cases: cases.length, succeeded: receipts.filter(r => r.status === 'OK').length,
  skipped: receipts.filter(r => r.status === 'SKIPPED').length,
  errors: receipts.filter(r => r.status === 'ERROR').length, contractMismatches: mismatches.length,
  providerRequests: 0, providerCostUsd: 0, genuineHumanLabels: 0,
  precision: { numerator: 0, denominator: 0, value: null },
  recall: { numerator: 0, denominator: 0, value: null },
  falsePositiveRate: { numerator: 0, denominator: 0, value: null },
  incorrectHighConfidence: { numerator: 0, denominator: 0, value: null },
  uncertaintyHandling: { numerator: 0, denominator: 0, value: null },
  citationSupportAccuracy: { numerator: 0, denominator: 0, value: null },
  liveLatencyMs: null, liveCostPerObservationUsd: null, humanReviewEffortSaved: null,
  recommendation: 'DEFER', reason: 'Offline contracts only. No model accuracy or human-effort evidence.',
}
await mkdir(out, { recursive: false })
await writeFile(join(out, 'receipts.jsonl'), receipts.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' })
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2))
if (mismatches.length) process.exitCode = 1
