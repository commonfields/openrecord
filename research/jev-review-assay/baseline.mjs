// Deterministic exact-value baseline. No model, no network, no randomness.
//
// It extracts typed values (money, percentages, dates, durations, counted
// quantities, and a closed lexicon of binary conditions) and compares them
// literally. It never converts currencies, billing periods, or date
// granularities: anything that would require an assumption is INCOMPARABLE and
// becomes AMBIGUOUS or an abstention. When the reference text has no typed
// value at all, the baseline abstains; qualitative facts are out of its scope.

export const BASELINE_VERSION = 'exact-value-baseline-v1'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const CURRENCY = {
  'US$': 'USD', $: 'USD', USD: 'USD', dollars: 'USD', '€': 'EUR', EUR: 'EUR', euros: 'EUR', '£': 'GBP', GBP: 'GBP',
  '¥': 'JPY', JPY: 'JPY', Rp: 'IDR', 'Rp.': 'IDR', IDR: 'IDR', CAD: 'CAD', AUD: 'AUD', SGD: 'SGD',
}
const CUR_PREFIX = '(US\\$|\\$|€|£|¥|Rp\\.?|USD|EUR|GBP|JPY|IDR|CAD|AUD|SGD)'
const CUR_SUFFIX = '(USD|EUR|GBP|JPY|IDR|CAD|AUD|SGD|dollars|euros)'
const NUM = '(\\d[\\d,.]*\\d|\\d)'
const PERIOD_RE = /^\s*(?:(?:per|a|an|each|\/)\s*(month|mo|year|yr|annum|week|day)\b|(monthly|annually|yearly|weekly|daily)\b)/i
const PERIOD = { month: 'month', mo: 'month', monthly: 'month', year: 'year', yr: 'year', annum: 'year', annually: 'year', yearly: 'year', week: 'week', weekly: 'week', day: 'day', daily: 'day' }
const DURATION_UNIT = { day: ['day', 1], days: ['day', 1], week: ['day', 7], weeks: ['day', 7], hour: ['hour', 1], hours: ['hour', 1], month: ['month', 1], months: ['month', 1], year: ['year', 1], years: ['year', 1] }
const NEGATORS = new Set(['not', 'no', 'never', 'without', 'non', 'cannot', 'nor'])
const CONDITIONS = {
  offer: /^offer(?:s|ed|ing)?$/, support: /^support(?:s|ed|ing)?$/, include: /^includ(?:e|es|ed|ing)$/,
  require: /^requir(?:e|es|ed|ing)$/, accept: /^accept(?:s|ed|ing)?$/, allow: /^allow(?:s|ed|ing)?$/,
  free: /^free$/, available: /^available$/, refund: /^refund(?:s|ed|able)?$/,
}

function parseNumber(raw, currency) {
  let s = raw
  // Indonesian Rupiah commonly uses '.' as a thousands separator.
  if (currency === 'IDR' && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  return Number(s)
}

const negatedBefore = (text, index) => {
  const words = text.slice(Math.max(0, index - 40), index).toLowerCase().split(/[^a-z']+/).filter(Boolean).slice(-3)
  return words.some(w => NEGATORS.has(w) || w.endsWith("n't"))
}

function periodAfter(text, end) {
  const m = PERIOD_RE.exec(text.slice(end, end + 24))
  return m ? PERIOD[(m[1] ?? m[2]).toLowerCase()] : null
}

export function extractValues(text) {
  if (typeof text !== 'string') return []
  const values = []
  const taken = []
  const free = (start, end) => !taken.some(([s, e]) => start < e && end > s)
  const take = (re, build) => {
    for (const m of text.matchAll(re)) {
      const start = m.index, end = m.index + m[0].length
      if (!free(start, end)) continue
      const value = build(m, start, end)
      if (!value) continue
      taken.push([start, end])
      values.push({ ...value, negated: negatedBefore(text, start), span: m[0] })
    }
  }
  const money = (cur, a, b, end) => {
    const currency = CURRENCY[cur] ?? CURRENCY[cur?.toLowerCase?.()] ?? null
    const min = parseNumber(a, currency), max = b === undefined ? min : parseNumber(b, currency)
    if (min === null || max === null) return null
    return { kind: 'money', currency, min, max, period: periodAfter(text, end) }
  }
  // Ranges first, so their endpoints are not compared as independent values.
  take(new RegExp(`${CUR_PREFIX}\\s?${NUM}\\s?(?:-|–|to)\\s?(?:${CUR_PREFIX})?\\s?${NUM}`, 'g'),
    (m, _s, e) => money(m[1], m[2], m[4], e))
  take(new RegExp(`\\bbetween\\s+${CUR_PREFIX}\\s?${NUM}\\s+and\\s+(?:${CUR_PREFIX})?\\s?${NUM}`, 'gi'),
    (m, _s, e) => money(m[1], m[2], m[4], e))
  take(new RegExp(`${CUR_PREFIX}\\s?${NUM}`, 'g'), (m, _s, e) => money(m[1], m[2], undefined, e))
  take(new RegExp(`(?<![\\w.])${NUM}\\s?${CUR_SUFFIX}\\b`, 'g'), (m, _s, e) => money(m[2], m[1], undefined, e))
  take(new RegExp(`(?<![\\w.])${NUM}\\s?(?:%|percent\\b)`, 'gi'), m => {
    const v = parseNumber(m[1]); return v === null ? null : { kind: 'percent', min: v, max: v }
  })
  const date = (y, mo, d) => ({ kind: 'date', year: y ? Number(y) : null, month: mo ?? null, day: d ? Number(d) : null })
  const month = name => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, m => date(m[1], Number(m[2]), m[3]))
  take(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'g'), m => date(m[3], month(m[1]), m[2]))
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}(?:\\s+(\\d{4}))?\\b`, 'g'), m => date(m[3], month(m[2]), m[1]))
  take(new RegExp(`\\b${MONTH_RE}\\s+(\\d{4})\\b`, 'g'), m => date(m[2], month(m[1]), null))
  const duration = (a, b, unitWord) => {
    const [unit, factor] = DURATION_UNIT[unitWord.toLowerCase()] ?? []
    if (!unit) return null
    const min = parseNumber(a), max = b === undefined ? min : parseNumber(b)
    return min === null || max === null ? null : { kind: 'duration', unit, min: min * factor, max: max * factor }
  }
  const UNIT = '(days?|weeks?|hours?|months?|years?)'
  take(new RegExp(`(?<![\\w.])${NUM}\\s?(?:-|–|to)\\s?${NUM}[\\s-]?${UNIT}\\b`, 'gi'), m => duration(m[1], m[2], m[3]))
  take(new RegExp(`\\bbetween\\s+${NUM}\\s+and\\s+${NUM}\\s+${UNIT}\\b`, 'gi'), m => duration(m[1], m[2], m[3]))
  take(new RegExp(`(?<![\\w.])${NUM}[\\s-]?(?:business[\\s-])?${UNIT}\\b`, 'gi'), m => duration(m[1], undefined, m[2]))
  take(/(?<=\b(?:in|since|from|of|by|year|until|before|after)\s)((?:19|20)\d{2})\b/gi, m => date(m[1], null, null))
  take(new RegExp(`(?<![\\w.])${NUM}(?:\\s+([A-Za-z]+))?`, 'g'), m => {
    const v = parseNumber(m[1]); if (v === null) return null
    return { kind: 'quantity', unit: m[2] ? m[2].toLowerCase().replace(/s$/, '') : null, min: v, max: v }
  })
  // Binary conditions from a closed lexicon, with local negation.
  for (const m of text.matchAll(/[A-Za-z']+/g)) {
    const word = m[0].toLowerCase()
    for (const [key, re] of Object.entries(CONDITIONS)) {
      if (re.test(word)) values.push({ kind: 'condition', key, negated: negatedBefore(text, m.index), span: m[0] })
    }
  }
  return values
}

const sameKind = (a, b) => a.kind === b.kind && (a.kind !== 'quantity' || a.unit === b.unit)
  && (a.kind !== 'duration' || a.unit === b.unit) && (a.kind !== 'condition' || a.key === b.key)

// Returns MATCH | CONFLICT | INCOMPARABLE for two values of the same kind.
function compareValue(ref, cand) {
  if (ref.kind === 'condition') return ref.negated === cand.negated ? 'MATCH' : 'CONFLICT'
  if (ref.kind === 'date') {
    const fields = ['year', 'month', 'day']
    const shared = fields.filter(f => ref[f] !== null && cand[f] !== null)
    if (shared.some(f => ref[f] !== cand[f])) return 'CONFLICT'
    if (fields.every(f => (ref[f] === null) === (cand[f] === null))) return 'MATCH'
    // An elided year with equal month and day is treated as the same date;
    // any other granularity difference (e.g. month-only) needs interpretation.
    if (ref.day !== null && cand.day !== null && ref.month !== null && cand.month !== null && cand.year === null) return 'MATCH'
    return 'INCOMPARABLE'
  }
  if (ref.kind === 'money') {
    if (ref.currency && cand.currency && ref.currency !== cand.currency) return 'INCOMPARABLE'
    if (ref.period && cand.period && ref.period !== cand.period) return 'INCOMPARABLE'
  }
  if (ref.min === cand.min && ref.max === cand.max) return 'MATCH'
  const refRange = ref.min !== ref.max, candRange = cand.min !== cand.max
  // A point inside a range (or overlapping ranges) needs interpretation.
  if ((refRange || candRange) && cand.min <= ref.max && cand.max >= ref.min) return 'INCOMPARABLE'
  return 'CONFLICT'
}

// Compare every reference slot against the candidate text.
export function compareExact(referenceText, candidateText, { conditionsRequired = true } = {}) {
  const ref = extractValues(referenceText).filter(v => !(v.kind !== 'condition' && v.negated))
  const cand = extractValues(candidateText)
  if (ref.length === 0) return { outcome: 'NO_REFERENCE_VALUES', slots: [] }
  const slots = ref.map(r => {
    const peers = cand.filter(c => sameKind(r, c))
    if (peers.length === 0) return { kind: r.kind, ref: r.span, status: 'NOT_FOUND', candidates: [] }
    const results = peers.map(c => {
      const res = compareValue(r, c)
      // An explicitly negated value ("not October 20") conflicts when equal and is
      // ignored when different. Conditions already carry polarity.
      if (c.kind !== 'condition' && c.negated) return res === 'MATCH' ? 'CONFLICT' : null
      return res
    }).filter(Boolean)
    const status = results.length === 0 ? 'NOT_FOUND'
      : results.includes('MATCH') && results.includes('CONFLICT') ? 'MIXED'
      : results.includes('MATCH') ? 'MATCH'
      : results.includes('INCOMPARABLE') ? 'INCOMPARABLE' : 'CONFLICT'
    return { kind: r.kind, ref: r.span, status, candidates: peers.map(p => p.span) }
  })
  // Fact-centric mode: lexical conditions are secondary when the reference has
  // typed values. An opposite-polarity condition still conflicts, but a
  // condition word the candidate merely does not repeat ("accepted" vs
  // "return") is not required. Claim-centric modes (does the evidence support
  // every part of the claim?) keep every condition slot required.
  const typed = slots.some(x => x.kind !== 'condition')
  if (!conditionsRequired && typed) for (let i = slots.length - 1; i >= 0; i--) if (slots[i].kind === 'condition' && slots[i].status === 'NOT_FOUND') slots.splice(i, 1)
  const has = s => slots.some(x => x.status === s)
  const outcome = has('MIXED') ? 'MIXED' : has('CONFLICT') ? 'CONFLICT' : has('INCOMPARABLE') ? 'INCOMPARABLE'
    : slots.every(x => x.status === 'MATCH') ? 'MATCH_ALL' : has('MATCH') ? 'PARTIAL' : 'NONE_COMPARABLE'
  return { outcome, slots }
}

const A_LABEL = { MATCH_ALL: 'SUPPORTS', CONFLICT: 'CONTRADICTS', MIXED: 'AMBIGUOUS', INCOMPARABLE: 'AMBIGUOUS', PARTIAL: 'AMBIGUOUS', NONE_COMPARABLE: 'NOT_ADDRESSED' }
const B_LABEL = { MATCH_ALL: 'SUPPORTS', CONFLICT: 'CONTRADICTS', MIXED: 'DOES_NOT_ADDRESS', INCOMPARABLE: 'DOES_NOT_ADDRESS', PARTIAL: 'DOES_NOT_ADDRESS', NONE_COMPARABLE: 'DOES_NOT_ADDRESS' }

// Task A (fact-centric): does the answer agree with the entire frozen fact?
export function baselineA({ factText, answer }) {
  const r = compareExact(factText, answer, { conditionsRequired: false })
  if (r.outcome === 'NO_REFERENCE_VALUES') return { label: null, abstain: 'NO_EXACT_VALUE_IN_FACT', ...r }
  return { label: A_LABEL[r.outcome], abstain: null, ...r }
}

// Task A on claim-centric historical rows: is the claim established by the facts?
export function baselineClaimVsFacts({ claim, facts }) {
  const r = compareExact(claim, facts.join(' \n '))
  if (r.outcome === 'NO_REFERENCE_VALUES') return { label: null, abstain: 'NO_EXACT_VALUE_IN_CLAIM', ...r }
  return { label: A_LABEL[r.outcome], abstain: null, ...r }
}

// Task B: does the preserved cited source text support the claim? A URL or an
// empty source is never support; the baseline abstains.
export function baselineB({ claim, sourceText }) {
  if (typeof sourceText !== 'string' || !sourceText.trim()) return { label: null, abstain: 'SOURCE_TEXT_MISSING', outcome: null, slots: [] }
  if (/^\s*https?:\/\/\S+\s*$/.test(sourceText)) return { label: null, abstain: 'URL_IS_NOT_SOURCE_CONTENT', outcome: null, slots: [] }
  const r = compareExact(claim, sourceText)
  if (r.outcome === 'NO_REFERENCE_VALUES') return { label: null, abstain: 'NO_EXACT_VALUE_IN_CLAIM', ...r }
  return { label: B_LABEL[r.outcome], abstain: null, ...r }
}
