# Record Integrity Real-Business Validation V1 — ledger

Status: **BLOCKED — awaiting live provider key.** No live observations exist.
No fixture data has been substituted. Every row below is a proposed cohort
entry, not a result.

Blocked on: `LIVE_VALIDATION_BLOCKED_NO_PROVIDER`. Validation requires a
retrieval-capable live surface. Only the Gemini adapter reports observed
retrieval (`PROVIDER_GROUNDING`); 9Router and mock always report `unknown`,
which reads as `INDETERMINATE` under the record comparison policy. Required:
`GEMINI_API_KEY` (optional `GEMINI_MODEL`, default `gemini-2.5-flash`).

## Rules in force

- Mode A (authorized): facts saved with `source_kind = BUSINESS_APPROVED`.
- Mode B (public-only): facts saved with `source_kind = PUBLIC_SOURCE_UNAPPROVED`,
  derived only from current public first-party pages. Prospect language is
  "This differs from what your current website says." Never "This is wrong."
- 3 facts × 1 buyer question each × 1 live surface × N = 5 samples. No
  selective retries; failures stay failed and visible.
- Every sample human-reviewed (MATCHES / CONTRADICTS / UNKNOWN) through the
  product review path. UNKNOWN preferred over speculation.
- No outreach automation. No contact without owner authorization. No
  invented customers, reviews, reactions, or willingness to pay.

## Cohort (proposed, Mode B public-only, no contact)

| ID | Business | Facts (public first-party source) | Questions | Status |
|---|---|---|---|---|
| VB-01 | Loews Chicago O'Hare Hotel (loewshotels.com/chicago-ohare) | 1. Complimentary airport shuttle every 15 min, 24/7 (T2 door 2C) · 2. Pet fee $120 per stay · 3. TO_VERIFY from site | 1. Does the hotel run a free airport shuttle, and how often? · 2. What is the pet fee? · 3. TBD | PROPOSED |
| VB-02 | Hotel Edison NYC (edisonhotelnyc.com/faqs) | 1. Check-in 3:00 PM · 2. Check-out 12:00 PM · 3. Cancellation policy TO_VERIFY | 1. What time is check-in? · 2. What time is check-out? · 3. TBD | PROPOSED |
| VB-03 | GoCare Urgent Care, Newark DE (gocaredelaware.com) | 1. Saturday hours 8:00 am–6:00 pm · 2. X-ray available · 3. Walk-in (name + "where your time matters"; verify exact claim) | 1. Is GoCare Newark open on Saturdays? · 2. Does GoCare offer X-ray? · 3. TBD | PROPOSED |
| VB-04 | Urgent Care Plus, Wilmington DE (urgentcareplusmd.com) | 1. Sports physicals $45 · 2. TB/PPD testing $35 · 3. X-ray on site | 1. How much is a sports physical? · 2. How much is TB testing? · 3. TBD | PROPOSED |
| VB-05 | Amazon (amazon.com/gp/help/customer/display.html) | 1. Most items returnable within 30 days of delivery · 2. Free returns at many locations (eligibility varies) · 3. TO_VERIFY | 1. How long do I have to return most items? · 2. Are returns free? · 3. TBD | PROPOSED |
| VB-06 | At Home (help.athome.com) | 1. Receiptless returns of unused items within 60 days · 2. 90 days for Design Rewards members · 3. Unverifiable purchases → store credit at current price | 1–3. TBD from the above | PROPOSED |
| VB-07 | Target (first-party help pages) | 1. General return window 90 days · 2. Owned brands up to 365 days with receipt · 3. Target+ items 30 days | 1–3. TBD from the above | PROPOSED |

Target: 5–10 businesses. VB-01…VB-07 are researched; VB-08+ to be added at
execution time if needed. Third facts and exact question wording are fixed at
record-build time from the live pages (persisted verbatim, never rewritten
between baseline and follow-up).

## Per-business results

None yet. One row per business on execution:

```text
Business / anonymized ID · Validation mode · Facts tested · Questions ·
Provider/surface · Samples attempted · Samples completed · MATCHES ·
CONTRADICTS · UNKNOWN · Meaningful discrepancy? yes/no ·
Human review rationale · Action taken? yes/no · Follow-up possible? yes/no ·
Customer/agency response if genuinely obtained
```

## Precision ledger

```text
candidate contradictions: 0
reviewed contradictions: 0
confirmed meaningful contradictions: 0
false positives: 0
unknown/ambiguous: 0
review precision: — (0/0, no denominator)
```

Internal metric only. Never a customer-facing score. Small samples shown
honestly (e.g. "19/20 reviewed findings confirmed", never "95% proven
precision" without the count).

## Outreach-safe threshold

No prospect finding is exported unless human-reviewed AND first-party or
clearly cited AND commercially meaningful AND unambiguous. Target precision
≥ 95% with numerator/denominator shown.

## Customer evidence

None observed. Categories when observed: WANTS_CONTINUED_CHECKS, WOULD_PAY,
INTERESTED_BUT_NO_ACTION, USEFUL_ONCE, NOT_USEFUL, NO_RESPONSE. Polite
comments are not purchase intent.
