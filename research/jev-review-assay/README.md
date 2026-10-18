# Jev review shadow assay

Offline contract tests for an optional evidence-review assistant. No live transport,
production imports, human judgment writes, or automatic findings exist here.
Read the [report](../../docs/research/jev-review-assay-v1.md) for contracts,
results, and the blinded evaluation plan. The recommendation is `DEFER`.

Use Node 24 from the repository root:

```sh
npm ci --prefix research/jev-review-assay --ignore-scripts --no-audit --no-fund
npm test --prefix research/jev-review-assay
npm run fixtures --prefix research/jev-review-assay -- reports/new-run
```

The last path is relative to this package because npm sets the working directory.
It must not exist yet. Committed example evidence is under `reports/offline-v1`.
The runner accepts no live flags. Ambient credentials cannot enable provider calls.

The SDK dependency is pinned in this standalone package and its lockfile. This
directory is outside the hosted pnpm workspace. Root checks do not run these tests;
run the command above explicitly. Fixture responses and token counts are authored
examples. They measure neither Jev accuracy nor provider latency.
