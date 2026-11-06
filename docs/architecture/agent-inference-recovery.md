# Inference recovery after completed work

Restored from `backup/local-development-20261106` alongside the newer cloud
plugins, chart replies, usage accounting, account actions and durable workers.

After useful tools complete, unavailable, timed-out, malformed or output-limited
inference gets at most one answer-only attempt on the **same selected model**.
The smaller request uses bounded returned evidence, declares no tools and rejects
tool calls. It never repeats research writes, approval, publication or spending.
Rate limits get no additional provider call. Context exhaustion may use the
smaller evidence-only request. When synthesis also fails, a clearly labeled
partial response retains summaries, citations and decision references.

Recovery is `ANSWERED_WITH_GAPS`, not successful completion of all requested
research. Original errors and recovery outcomes remain in the run journal.
Safe HTTP status is retained; provider bodies are not. Cancellation, revoked
authority, configuration errors and failure before useful work still stop.

The restored default output allowance is 8192 tokens, configurable through
`AGENT_MAX_OUTPUT_TOKENS`. Model requests include system/schema/history bytes
under a conservative 128 KB ceiling, not tokenizer-aware accounting. An inner
eight-minute budget reserves 75 seconds for answering inside the nine-minute
outer timeout; each model call has a 60-second ceiling. Explicit campaign,
status and report commands narrow tools; ordinary conversation retains tools.

Migration **0079** adapts the old local 0074 finding checkpoints. Bounded tool
excerpts are stored separately from activity. Resume context uses only the same
account, business and user; excerpts remain untrusted incomplete observations,
never authority. Migration 0080 restores explicitly opted-in background setup.
Existing setups require Continue before background progression.

The client submits durable requests once, polls stored results, and reattaches
on chat navigation/reload. Detaching is not cancellation. Ambiguous interrupted
requests are never automatically resubmitted. The stronger merged worker fencing
and pre-execution recovery remain unchanged.

Fixture tests cover recovery, no-tool synthesis, rate limits, cancellation,
checkpoints, scoped resume, durable request polling and setup races. No live
provider outage, long-research reliability or production readiness is claimed.
Cross-provider failover remains disabled pending explicit cost/privacy policies.

## Context packing before recovery (2026-11-06)

A real local run read twelve tools successfully, then failed the runtime's
context preflight. Its third normal inference never reached the model; an
answer-only recovery returned partial findings. This was local context
engineering failure, not evidence that the selected model was unavailable.

Previously, compaction never touched the newest tool batch and counted JavaScript
characters while the request ceiling counted UTF-8 bytes. Large batches could
therefore exhaust the remaining envelope after schema/system overhead, even
when each result individually fit its own limit.

The harness now:

- Allocates initial history/resume space after actual instruction/schema bytes.
  The current user request is never shortened to make an impossible request fit.
- Counts UTF-8 bytes consistently. Compacts older evidence first, then projects
  the latest batch only when necessary instead of immediately abandoning work.
- Keeps available identifiers, receipts, revisions, numeric values and source
  context in deterministic projections. Omitted fields/items/text are explicitly
  labelled partial; source totals are not denominators for shortened lists.
- Never rewrites model tool-call arguments or retries a write to recover detail.
  Original source records and durable checkpoints are not changed by projection.
- Records request bytes, tool count, fit status and compaction in the journal.
  Local envelope failures have distinct safe details; no request bodies or
  credentials are added to diagnostics.
- Bounds the marketing work tool's response to 16 KB, trimming lower-priority
  actions/learning with explicit omission flags. It no longer duplicates full
  closed-campaign learning/results inside campaign summaries. Persisted records
  remain unchanged.

The 128 KB canonical request ceiling is unchanged. This is still conservative
byte accounting, not a provider-specific tokenizer or context-window promise.

## Live-model checks and limits

Used the same configured subscription/model (`codex:gpt-6.1-terra`), with fixed
scenario evidence and no live business mutation or external marketing execution.

| Check | Observed result |
| --- | --- |
| Goal-aware planning, small evidence | Completed; semantic checks passed; about 52 seconds. |
| Strategy recommendation, small evidence | Completed; semantic checks passed; about 44 seconds. |
| Context-pressure marketing batch | Two model steps, one compaction, maximum canonical request 124,245 bytes; ANSWERED with no gaps; about 44 seconds. |
| Concrete campaign drafting | Four model steps; called the draft tool with schema-valid page copy and distribution; explicitly preview-only; ANSWERED with no gaps; about 63 seconds. |

The initial pressure grader incorrectly required a redundant growth-goal read
when the investigation result already supplied the goal. The initial draft
grader misclassified "Nothing was published" as a positive publication claim.
Both evaluator issues were corrected and the existing reports regraded without
new model calls; original reports remain local under `~/.openrecord/evals/`.
Regression checks still reject affirmative claims of publication.

These are single samples on different scenarios, not a before/after speedup,
model ranking or marketing-effectiveness benchmark. The draft tool in live
evaluation captures a preview in the report, not a business campaign. Database
integration tests separately validate actual scoped persistence and replay.
Evaluation now reports completion/gaps, compactions, request bytes and model
steps; a partial recovery cannot pass merely because its prose contains the
expected numbers. Regrading honors recorded incomplete outcomes too.

## Next harness and shared-context work (not implemented here)

1. Discover relevant tools progressively from the scoped registry rather than
   putting every schema in every inference. Discovery cannot expand permissions.
2. Retrieve business decisions, campaign revisions, evidence and unfinished work
   by relevance with provenance, timestamps and supersession. Keep private
   session context separate; do not concatenate every session into a prompt.
3. Derive graph relationships from durable campaign/evidence/decision records
   where useful. A graph database alone does not supply correct memory, freshness
   or authority; existing scoped records remain the source of truth.
4. Add sustained task and cross-session acceptance tests with independently
   checked artifacts and real integration receipts, beyond a single answer.
5. Coding execution needs a deliberately scoped workspace/sandbox, reviewed
   diffs, tests and approval boundaries. No unrestricted coding or shell tool was
   added to the product agent by this change.
