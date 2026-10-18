import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { cases, response } from './fixtures.mjs'
import { QUESTIONS, classificationCounts, digest, parseResponse, prepare, runOfflineCase } from './assay.mjs'

for (const row of cases) test(`offline contract: ${row.input.id}`, async () => {
  const r = await runOfflineCase(row.input, row.fixture)
  assert.equal(r.decision?.choice ?? r.errorClass, row.expected)
  assert.equal(r.status, r.decision ? 'OK' : 'SKIPPED')
  assert.equal(r.sdkRequests, r.decision ? 1 : 0)
  assert.equal(r.officialJudgment, 'UNCHANGED')
  assert.equal(r.inputDigest, digest(row.input))
  assert.equal(r.questionDigest, digest(QUESTIONS[row.input.task]))
  assert.ok(r.latencyMs >= 0)
  assert.equal(r.cost.usd, 0)
  if (r.decision) {
    assert.equal(r.observedModel, r.requestedModel)
    assert.equal(r.usage.input_tokens, 100)
    assert.deepEqual(r.question, QUESTIONS[row.input.task])
  }
})

test('expected label and reviewer information never enter the SDK state', () => {
  const p = prepare({ ...cases[0].input, expected: 'CONTRADICTS', reviewer: 'secret-reviewer' })
  assert.equal(JSON.stringify(p.state).includes('secret-reviewer'), false)
  assert.equal('expected' in p.state, false)
})

test('unknown and confidential material is refused before transport', async () => {
  for (const patch of [{ material: 'CONFIDENTIAL' }, { task: 'C' }, { context: '' }, { factValidAtObservation: null }]) {
    const r = await runOfflineCase({ ...cases[0].input, ...patch }, {})
    assert.equal(r.status, 'ERROR')
    assert.equal(r.errorClass, 'INVALID_INPUT')
    assert.equal(r.sdkRequests, 0)
  }
})

test('exact quotation matching does not normalize or infer support', () => {
  const base = cases.find(c => c.input.id === 'citation-support').input
  assert.equal(prepare({ ...base, quotation: 'usd 20 monthly' }).blocked, 'EXACT_QUOTE_NOT_FOUND')
  assert.ok('state' in prepare(base))
})

test('rejects invalid probabilities, choices, usage, and missing identity', () => {
  const malformed = [
    r => { r.answers.review.choice = 'MATCHES' },
    r => { delete r.answers.review.probabilities.AMBIGUOUS },
    r => { r.answers.review.probabilities.extra = 0 },
    r => { r.answers.review.probabilities.SUPPORTS = NaN },
    r => { r.answers.review.probabilities.SUPPORTS = 1.1 },
    r => { r.answers.review.probabilities.SUPPORTS = 0.1 },
    r => { r.answers.review.confidence = -1 },
    r => { r.usage.input_tokens = -1 },
    r => { r.model = '' },
    r => { r.answers.review.choice = 'AMBIGUOUS' },
  ]
  for (const mutate of malformed) {
    const r = response('A', 'SUPPORTS'); mutate(r)
    assert.throws(() => parseResponse(r, 'A'), /MALFORMED_RESPONSE/)
  }
  const r = response('A', 'SUPPORTS'); r.usage = { input_tokens: null, output_tokens: null }
  assert.deepEqual(parseResponse(r, 'A').usage, { input_tokens: null, output_tokens: null })
})

test('HTTP failures never retry, expose error bodies, or become decisions', async () => {
  for (const [httpStatus, expected] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'PROVIDER_UNAVAILABLE']]) {
    const r = await runOfflineCase(cases[0].input, { httpStatus, response: { detail: 'credential-canary' } })
    assert.equal(r.errorClass, expected)
    assert.equal(r.sdkRequests, 1)
    assert.equal(r.decision, null)
    assert.equal(JSON.stringify(r).includes('credential-canary'), false)
  }
})

test('connection, malformed response, and changed model stay unavailable', async () => {
  const drift = response('A', 'SUPPORTS'); drift.model = 'unrequested-model'
  for (const [fixture, expected] of [[{ error: 'CONNECTION' }, 'CONNECTION'],
    [{ response: {} }, 'MALFORMED_RESPONSE'], [{ response: drift }, 'MODEL_IDENTITY_MISMATCH']]) {
    const r = await runOfflineCase(cases[0].input, fixture)
    assert.equal(r.errorClass, expected)
    assert.equal(r.status, 'ERROR')
    assert.equal(r.decision, null)
  }
})

test('metric arithmetic includes unavailable contradictions in recall denominator', () => {
  // Fabricated count examples verify formulas only, never model quality.
  const r = classificationCounts([
    { expected: 'CONTRADICTS', predicted: 'CONTRADICTS', probability: 0.95 },
    { expected: 'CONTRADICTS', predicted: null, probability: null },
    { expected: 'SUPPORTS', predicted: 'CONTRADICTS', probability: 0.95 },
    { expected: 'AMBIGUOUS', predicted: 'AMBIGUOUS', probability: 0.8 },
  ])
  assert.deepEqual(r.precision, { numerator: 1, denominator: 2, value: 0.5 })
  assert.deepEqual(r.recall, { numerator: 1, denominator: 2, value: 0.5 })
  assert.deepEqual(r.falsePositiveRate, { numerator: 1, denominator: 2, value: 0.5 })
  assert.deepEqual(r.incorrectHighConfidence, { numerator: 1, denominator: 2, value: 0.5 })
  assert.equal(r.unavailable, 1)
  assert.equal(r.uncertaintyHandling.value, 1)
  assert.equal(classificationCounts([]).precision.value, null)
})

test('SDK fixtures never use global network or ambient model and credential configuration', async () => {
  const savedFetch = globalThis.fetch
  const keys = { TYPESAFE_API_KEY: 'credential-canary', TYPESAFE_BASE_URL: 'https://network-canary.invalid',
    TYPESAFE_DEFAULT_MODEL: 'wrong-model', TYPESAFE_LOG_LEVEL: 'debug' }
  const saved = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]))
  let attempts = 0
  globalThis.fetch = () => { attempts++; throw new Error('network disabled') }
  Object.assign(process.env, keys)
  try {
    const r = await runOfflineCase(cases[0].input, cases[0].fixture)
    assert.equal(r.status, 'OK')
    assert.equal(attempts, 0)
    assert.equal(JSON.stringify(r).includes('credential-canary'), false)
    assert.equal(JSON.stringify(r).includes('network-canary'), false)
    assert.equal(JSON.stringify(r).includes('wrong-model'), false)
  } finally {
    globalThis.fetch = savedFetch
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('research imports no production code and hosted code imports no review assay', async () => {
  const root = new URL('../../', import.meta.url)
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) await walk(path)
      else if (/\.[cm]?[jt]sx?$/.test(e.name)) {
        assert.doesNotMatch(await readFile(path, 'utf8'), /(?:from|import\s*\(|require\s*\()[^\n]*(?:jev-review-assay|@typesafe-ai\/sdk)/, path)
      }
    }
  }
  await walk(new URL('apps', root).pathname)
  await walk(new URL('packages', root).pathname)
  for (const file of ['assay.mjs', 'baseline.mjs', 'labels.mjs', 'metrics.mjs', 'protocol.mjs', 'corpus.mjs', 'run-fixtures.mjs']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /(?:from|import\s*\()[^\n]*(?:packages\/|apps\/|'pg'|postgres)/, file)
    assert.doesNotMatch(source, /process\.env|globalThis\.fetch|\bfetch\(/, file)
  }
})

test('CLI refuses live flags and preserves an existing report directory', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'jev-shadow-test-'))
  try {
    const script = new URL('./run-fixtures.mjs', import.meta.url).pathname
    const out = join(temp, 'new-run')
    const run = args => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' })
    assert.throws(() => run(['--live']))
    run([out])
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'))
    assert.equal(summary.contractMismatches, 0)
    assert.equal(summary.liveExecution, 'NOT_EXECUTED')
    assert.equal(summary.pipelineExercise.interpretation, 'NOT_A_MODEL_RESULT')
    assert.equal(summary.baselineSynthetic.material, 'SYNTHETIC')
    assert.equal(summary.verdict, 'JEV_ASSAY_BLOCKED_REFERENCE_LABELS')
    assert.equal(summary.precision.value, null)
    assert.equal(summary.genuineHumanLabels, 0)
    assert.equal(summary.providerRequests, 0)
    assert.equal(summary.recommendation, 'DEFER')
    const first = await readFile(join(out, 'receipts.jsonl'), 'utf8')
    assert.throws(() => run([out]))
    assert.equal(await readFile(join(out, 'receipts.jsonl'), 'utf8'), first)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
