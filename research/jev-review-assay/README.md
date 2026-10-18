# Jev shadow assay (research only)

This is an offline harness for evaluating Jev as an optional, narrow review
aid. It covers Task A (factual contradiction assistance) and Task B (citation
support). It has no live transport, no production imports, no database access,
no human-judgment writes, and no automatic findings.

The report, protocol, and verdict are in
[`docs/research/jev-review-assay-v1.md`](../../docs/research/jev-review-assay-v1.md).
The verdict is `JEV_ASSAY_BLOCKED_REFERENCE_LABELS` (it is also blocked on
authorization). The recommendation is `DEFER`.

| File | Purpose |
|---|---|
| `assay.mjs` | Choice contracts, preflight refusals, SDK fixture transport, receipts |
| `labels.mjs` | Jev label sets and the explicit many-to-one mapping to OpenRecord MATCHES/CONTRADICTS/UNKNOWN |
| `baseline.mjs` | Deterministic exact-value baseline (money, dates, durations, percentages, quantities, conditions) |
| `metrics.mjs` | Confusion matrix, per-class P/R/F1, macro F1, coverage, abstention, high-confidence FPs, Brier/ECE, latency, cost, effective n |
| `protocol.mjs` | Split by business, dev-only threshold policy, reference-label and live-readiness gates, request budget, spending bound, drift check |
| `corpus.mjs` | **Synthetic** corpora: historical `research/jev-assay` rows (read only) plus fictional fact-centric rows |
| `fixtures.mjs` | Authored adapter contract cases |
| `status/` | Counts-only reference-label status and the live-readiness checklist |
| `reports/offline-v2/` | Committed fixture/synthetic run: `summary.json`, `receipts.jsonl` |

Use Node 24 from the repository root:

```sh
npm ci --prefix research/jev-review-assay --ignore-scripts --no-audit --no-fund
npm test --prefix research/jev-review-assay
npm run fixtures --prefix research/jev-review-assay -- reports/new-run
```

The output path is relative to this package and must not exist yet. The runner
accepts no live, credential, model, or customer-data flags. Ambient `TYPESAFE_*`
variables cannot enable provider calls.

This directory is outside the pnpm workspace and the root ESLint globs, so
root lint, typecheck, and test do not run it. Run the commands above
explicitly.

Fixture responses, token counts, and latencies are authored or local. They
measure neither Jev accuracy nor provider latency. Synthetic rows carry
`labelOrigin = synthetic_constructed` and can never satisfy the
reference-label gate.

Never commit private validation evidence here. The repository is public, so
`status/reference-status.json` carries counts only.
