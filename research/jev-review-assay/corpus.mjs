// SYNTHETIC engineering corpora. Every row is constructed, carries
// labelOrigin = 'synthetic_constructed', and names only obviously fictional
// businesses. None of it is business evidence or a human label; it exists to
// exercise the adapter, baseline, split, and metric code paths.
import { readFileSync } from 'node:fs'
import { HISTORICAL_A_TO_JEV, HISTORICAL_B_TO_JEV, fourClassReference } from './labels.mjs'

const HIST = new URL('../jev-assay/datasets/', import.meta.url)
// Entity names used by research/jev-assay/datasets/generate.py (fictional).
const HIST_NAMES = ['OpenRecord', 'Acme Analytics', 'Northwind', 'Blue Canoe', 'Hexagonal', 'Quartz Labs']

const readJsonl = name => readFileSync(new URL(name, HIST), 'utf8').split('\n')
  .filter(l => l.trim() && !l.startsWith('#')).map(l => JSON.parse(l))
const entityOf = row => {
  const text = [row.claim, ...(Array.isArray(row.evidence) ? row.evidence : [row.evidence])].join(' ')
  return HIST_NAMES.find(n => text.includes(n)) ?? 'unknown-entity'
}

// Historical rows are claim-centric (is the claim established by the evidence?)
// and each row is its own fact: there are no repeated observations.
export function historicalA() {
  return readJsonl('task_a_synthetic.jsonl').map(r => ({
    id: r.case_id, task: 'A_CLAIM_CENTRIC', businessId: `synthetic:${entityOf(r)}`, factId: r.case_id,
    claim: r.claim, facts: r.evidence, reference: HISTORICAL_A_TO_JEV[r.label], historicalLabel: r.label,
    category: r.category, labelOrigin: r.label_origin,
  }))
}
export function historicalB() {
  return readJsonl('task_b_synthetic.jsonl').map(r => ({
    id: r.case_id, task: 'B', businessId: `synthetic:${entityOf(r)}`, factId: r.case_id,
    claim: r.claim, sourceText: r.evidence, reference: HISTORICAL_B_TO_JEV[r.label], historicalLabel: r.label,
    category: r.category, labelOrigin: r.label_origin,
  }))
}

const MONTHS = ['March', 'April', 'May', 'June', 'July', 'August', 'September']
// Letter names: digits inside an entity name would pollute exact-value slots
// (a known baseline limitation, documented rather than special-cased).
const NAME = b => `Synthetic Business ${String.fromCharCode(64 + b)}`

// Fact templates and answer variants. `decision` is the constructed reference
// in OpenRecord's vocabulary; `unknownReason` refines UNKNOWN for 4-class use.
function factsFor(b) {
  const price = 10 + b * 5, days = [7, 14, 30][b % 3], day = 3 + b, month = MONTHS[b % MONTHS.length]
  return [
    { slot: 'price', text: `The Basic plan of ${NAME(b)} costs USD ${price} per month.`,
      variants: [
        [`Basic costs USD ${price} per month.`, 'MATCHES'],
        [`Basic costs $${price} a month.`, 'MATCHES'],
        [`Basic costs USD ${price + 7} per month.`, 'CONTRADICTS'],
        [`Basic costs EUR ${price} per month.`, 'UNKNOWN', 'AMBIGUOUS'],
        [`Basic costs USD ${price} per year.`, 'UNKNOWN', 'AMBIGUOUS'],
        [`Some sources say USD ${price}, others USD ${price + 7} per month.`, 'UNKNOWN', 'AMBIGUOUS'],
        ['The Basic plan is free.', 'CONTRADICTS'],
        ['They sell handmade goods online.', 'UNKNOWN', 'NOT_ADDRESSED'],
      ] },
    { slot: 'duration', text: `Returns are accepted within ${days} days of delivery.`,
      variants: [
        [`You can return items within ${days} days.`, 'MATCHES'],
        [`Returns are accepted for ${days + 15} days.`, 'CONTRADICTS'],
        [`Returns are possible within ${Math.max(1, days - 5)}-${days + 10} days.`, 'UNKNOWN', 'AMBIGUOUS'],
        ['Returns are not accepted.', 'CONTRADICTS'],
        ['Shipping is fast.', 'UNKNOWN', 'NOT_ADDRESSED'],
      ] },
    { slot: 'date', text: `The spring sale starts on ${month} ${day}, 2026.`,
      variants: [
        [`The sale starts ${month} ${day}, 2026.`, 'MATCHES'],
        [`The sale starts on ${month} ${day + 4}, 2026.`, 'CONTRADICTS'],
        [`The sale starts in ${month} 2026.`, 'UNKNOWN', 'AMBIGUOUS'],
        [`The sale does not start on ${month} ${day}.`, 'CONTRADICTS'],
        ['There is a newsletter.', 'UNKNOWN', 'NOT_ADDRESSED'],
      ] },
    { slot: 'qualitative', text: `${NAME(b)} is a family-owned shop.`,
      variants: [
        ['It is run by one family.', 'MATCHES'],
        ['It is owned by a national retail chain.', 'CONTRADICTS'],
        ['It has a physical store.', 'UNKNOWN', 'NOT_ADDRESSED'],
      ] },
  ]
}

export function factCentricA({ businesses = 9, samples = 5 } = {}) {
  const rows = []
  for (let b = 1; b <= businesses; b++) {
    for (const [fi, fact] of factsFor(b).entries()) {
      for (let s = 0; s < samples; s++) {
        // Repeated observations of one fact are correlated: most samples repeat
        // the fact's dominant answer pattern and the last sample varies.
        const dominant = (b * 3 + fi) % fact.variants.length
        const [answer, decision, unknownReason = null] = fact.variants[s < samples - 1 ? dominant : (dominant + 1 + b) % fact.variants.length]
        const id = `synthetic-a-b${b}-${fact.slot}-s${s + 1}`
        rows.push({
          id, task: 'A', businessId: `synthetic-business-${b}`, factId: `synthetic-b${b}-${fact.slot}`, slot: fact.slot,
          reference: decision, unknownReason, reference4: fourClassReference(decision, unknownReason),
          labelOrigin: 'synthetic_constructed',
          input: {
            task: 'A', id, material: 'SYNTHETIC',
            fact: { id: `synthetic-b${b}-${fact.slot}`, version: 1, text: fact.text, authority: 'BUSINESS_APPROVED' },
            prompt: `Synthetic question ${fact.slot} about ${NAME(b)}.`,
            answer, supportingText: answer, sourceEvidence: null,
            factValidAtObservation: true, retrievalObserved: true,
            context: `${NAME(b)}; compare the same entity and scope; no currency or period conversion is established.`,
          },
        })
      }
    }
  }
  return rows
}

export function factCentricB({ businesses = 9 } = {}) {
  const rows = []
  for (let b = 1; b <= businesses; b++) {
    const price = 10 + b * 5
    const claims = [
      ['supports', `Basic costs USD ${price} per month.`, `Pricing page: the Basic plan is USD ${price} per month.`, 'SUPPORTS'],
      ['contradicts', `Basic costs USD ${price} per month.`, `Pricing page: the Basic plan is USD ${price + 9} per month.`, 'CONTRADICTS'],
      ['irrelevant', `Basic costs USD ${price} per month.`, 'About us: we started as a weekend market stall.', 'DOES_NOT_ADDRESS'],
      ['partial', `Basic costs USD ${price} per month and includes delivery.`, `Pricing page: Basic is USD ${price} per month.`, 'DOES_NOT_ADDRESS'],
      ['url-only', `Basic costs USD ${price} per month.`, '', 'SOURCE_NOT_PRESERVED'],
      ['qualitative', 'The shop is family-owned.', 'Our story: three generations of one family run the shop.', 'SUPPORTS'],
    ]
    for (const [kind, claim, sourceText, reference] of claims) {
      const id = `synthetic-b-b${b}-${kind}`
      rows.push({
        id, task: 'B', businessId: `synthetic-business-${b}`, factId: `synthetic-b${b}-claim-${kind}`, slot: kind,
        reference, labelOrigin: 'synthetic_constructed',
        citationUrl: `https://synthetic-business-${b}.invalid/source`,
        input: { task: 'B', id, material: 'SYNTHETIC', claim, sourceText, quotation: '',
          context: `${NAME(b)} first-party source; scope limited to the supplied text.` },
      })
    }
  }
  return rows
}
