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
