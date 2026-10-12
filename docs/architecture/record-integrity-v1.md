# Record Integrity V1 — architecture

One product primitive:

> A business has an approved record of what is true. OpenRecord observes how
> that business is represented elsewhere, identifies supported disagreement,
> records human judgment, and preserves what happened over time.

The loop: Authoritative Record → Observation → Claim → Comparison → Human
Judgment → Integrity Finding → Action → Follow-up Observation → Observed
Outcome. This document maps that loop onto the tables that implement it,
records where the live model diverges from the vocabulary, and lists the
invariants that must not be broken.

## Domain mapping

| Concept | Implementation |
|---|---|
| Record | `record_profiles` (client website + engagement) + approved `record_items` heads. Read as `RecordSnapshot` (`packages/db/src/record.ts`), derived as operator/public views (`record-view.ts`). |
| AuthoritativeFact version | `authoritative_facts` row: `(subject, predicate)` identity, `value_text/type`, `version`, `supersedes_id` chain, `[valid_from, valid_until)`, `status`. Never updated in place except `status` (0023 `guard_record_fact_content`). Repository-managed businesses sync through `repository_fact_provenance` + `business_authority_mode`. |
| Observation | `observations` row + `raw_evidence` (immutable, digest-verified) + `observation_citations` + `measurement_context`/`surface_identity`. One row per `(run, slot, sample)` via `check_runs(record_run_id, record_item_id, record_sample)`. Retrieval honesty: `retrieval_mode` records what was **observed** (`PROVIDER_GROUNDING`, `WEB_SEARCH`, …), `request_parameters` what was **requested**. The two are never conflated (`retrievalObserved` vs `retrievalRequested`). |
| Claim | `record_claims` (0024): `(observation_id, item_id)`, `fact_key` (the reviewed predicate, denormalized), `claim_text`, optional verbatim `supporting_span`, `extraction_method` (`MANUAL_TRANSCRIPTION` / `MANUAL_EXACT_SPAN`). A span must occur verbatim in the observed answer (database guard); ambiguous text stays a whole-answer transcription. |
| Judgment | `record_judgments`: `MATCHES` / `CONTRADICTS` / `UNKNOWN` per observation, append-only correction chain via `supersedes_id`, reviewer = session account member at server time. Pins `claim_id` (nullable), `fact_id` + `fact_version` (mandatory): **judgment truth version = fact version valid_at observation.collected_at**, enforced by `guard_record_judgment` and pre-checked by `RecordRepository.judge` (`FactNotValidAtObservation`). |
| IntegrityFinding | **Derived, not stored** (divergence, deliberate): `findingFor()` in `record-view.ts` computes `{ kind, state, samples }` per slot from stored judgments, actions and outcomes. Identity is the business slot (fact predicate), never the evidence wording — new observations attach to the existing finding. States: `NEEDS_REVIEW`, `OPEN`, `ACTION_RECORDED`, `FOLLOW_UP_PENDING`, `AGREEMENT`, plus the four outcomes below. There is no explicit `ACKNOWLEDGED` gesture yet; a reviewed contradiction with no action is `OPEN`. |
| Action | `interventions` (human, account-member actor) linked by `record_actions` to a slot or the whole record. Evidence of what the operator says they did — never proof of deployment, indexing, consumption, or causation. |
| Outcome | **Derived, never stored**: `compareSlot()` over reviewed before/after sample sets. `OBSERVED_CORRECTED` (contradiction → agreement **with** a recorded action between), `NO_OBSERVED_CHANGE`, `INDETERMINATE` (+ reason), `RESOLVED_EXTERNALLY` (agreement with **no** recorded action — the product takes no credit). `CAUSALITY_DISCLOSURE` accompanies every comparison. |

## Divergences from the milestone vocabulary (deliberate)

1. **Findings are a read model, not a table.** The legacy issue loop (`candidate_claims` → `human_judgments` → derived `IssueState`) and `site_findings` already proved that storing verdicts creates drift risk. `SlotFinding` derives from the same rows the UI counts, so "4 of 5 contradicted" and the finding state cannot disagree.
2. **Claims are optional per judgment.** Reviewers may judge the whole observed answer (`claim_id` NULL, method `MANUAL_TRANSCRIPTION` by convention) or quote an exact span (stored claim, `MANUAL_EXACT_SPAN`). No machine extraction exists on this path — matching the `candidate_claims` manual-only precedent.
3. **`OBSERVED_CORRECTION` → `OBSERVED_CORRECTED`.** Renamed to the milestone vocabulary; the old string appears nowhere else (the protocol's `ObservedOutcome` is the separate issue-loop vocabulary and is untouched).
4. **Temporal routing is lineage-first, windows-second.** Supersession never rewrites old `[valid_from, valid_until)` windows (0023 immutability). The exact authority for "which truth applies" is the item→fact binding of the check that produced the observation; the validity window is the backstop that refuses drifted judgments. Overlapping windows across a supersession are therefore normal; the version chain disambiguates.
5. **Sampling policy lives on the run** (`record_runs.sample_count`, 1–5). A follow-up must reuse its baseline count (`SamplingPolicyChanged`); provider/model changes are allowed but read as `SURFACE_CHANGED`, never silently substituted.
6. **Slot cap of 3 and the `record_items` slot chain predate this milestone** and are unchanged. Ordinary business facts only: predicates are free text (`price`, `opening_hours`, `policy`, …); no SaaS ontology is encoded anywhere in the new code.

## Remaining duplication / future convergence

- `candidate_claims`/`human_judgments` (legacy loop) overlap `record_claims`/`record_judgments` (record loop). The legacy loop serves the issue inbox; the record loop serves the client record. Convergence direction: port the inbox read model onto record primitives when the inbox adopts slots; do not merge tables until then.
- `assay_sample_judgments` (`MATCHES/CONTRADICTS/NOT_MENTIONED/UNCLEAR`) overlap the record `UNKNOWN`. The mapping `NOT_MENTIONED/UNCLEAR → UNKNOWN` is the canonical public meaning; a shared `Verdict` type is future work.
- `SlotFinding` could become durable if findings need cross-run discussion threads. Until then, derivation is the integrity guarantee.

## Invariants that must not be broken

1. Raw observations and raw evidence cannot be mutated (`prevent_observation_mutation`, digest check on write).
2. Human judgments cannot be fabricated by workers/seeds/scripts/migrations (architecture test + `record_member` guards + append-only triggers).
3. A judgment pins the fact version valid when the observation was collected (DB guard + repo pre-check + temporal acceptance test).
4. `UNKNOWN` never becomes `CONTRADICTS`/`MATCHES` automatically (aggregation rule + tests).
5. A fact edit appends history (`SUPERSEDED` + new version); tracked content is immutable in place.
6. Public records expose only approved, active facts through the explicit allowlist; drafts stay private.
7. Revoked/unknown/malformed share ids serve the identical non-disclosing 404; shares never reactivate.
8. Follow-up outcomes derive from stored observations on every request; nothing is cached or precomputed.
9. `OBSERVED_CORRECTED` requires reviewed contradiction before, unanimous reviewed agreement after, comparable retrieval-backed surfaces, and a recorded action between.
10. `RESOLVED_EXTERNALLY` carries no attributable action (`actions: []`) and "takes no credit" copy.
11. Provider/retrieval capability is never silently substituted (run/check binding guards + `SURFACE_CHANGED`/`SURFACE_UNKNOWN`).
12. Cross-tenant record/claim/judgment/evidence access fails closed (composite `(id, business_id)` keys + session scoping).
