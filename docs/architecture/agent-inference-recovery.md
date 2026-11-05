# Inference recovery after completed work

The November 4 local runs showed an unavailable provider after 24 tool calls, output-limit failures, and rate limiting. Those were distinct inference failures; saved research did not mean a final answer had been generated.

The conversation loop now validates candidate output at the inference boundary. After useful tool work, an unavailable, timed-out, malformed or output-limited response gets at most one answer-only attempt using the same selected model and already-returned evidence. The attempt stays within the model-step budget and declares no tools. Tool calls in its response are rejected, not dispatched. It cannot repeat a research write, approval or publication.

Rate limits trigger no additional provider request. Context exhaustion can recover with a smaller, tool-free request containing bounded completed-evidence excerpts, not the full failed history. If synthesis is unavailable, the server returns a clearly labeled partial response with bounded summaries of completed work and preserved citations/decision references. It does not turn summary counts into conclusions or claim the requested analysis finished. Raw tool payloads, credentials and provider error bodies are not dumped into the user-facing fallback.

Recovered responses are `ANSWERED_WITH_GAPS`, not silently successful research. The journal retains the original failure, recovery attempt and outcome. Safe numeric HTTP status is retained when available; provider bodies are discarded. Cancellation, revoked authority, missing configuration and failures before any useful work still stop the request. Conversation leases and commit authority continue to apply.

The hosted default output allowance is now 8192 tokens (configurable with `AGENT_MAX_OUTPUT_TOKENS`) instead of 2048, which was insufficient for several observed thinking-model responses. This is an upper bound, not a promise of response length or a fix for provider outages. The existing overall turn timeout still applies; process crashes and exhausted wall-clock deadlines use the durable interruption path.

## Further hardening

- Preflight counts UTF-8 bytes for system, schemas and contents together (128 KB ceiling), while retaining the existing history compaction. This is a conservative byte bound, not tokenizer-aware context accounting.
- An inner eight-minute run budget reserves the last 75 seconds for an answer, inside the existing nine-minute outer deadline. Serial and delegated tool dispatches are bounded by the research deadline; model calls have a 60-second ceiling. Exhausted step/tool budgets remove tool declarations during the answer phase. Timeout interruption cannot undo a remote operation already accepted by a provider; receipts must be inspected before retrying external work.
- Explicit campaign/status/report commands use narrower tool sets. Ordinary ambiguous conversation still retains general tools; evaluated progressive tool discovery remains outstanding.
- Hosted 401/403 and bridge authentication failures are configuration failures, not transient downtime. Bridge cancellation remains cancellation; its queue polling deadline reports timeout.
- Migration `0074_agent_finding_checkpoints.sql` stores bounded scoped-tool result excerpts separately from the activity journal. Recent partial/failed findings are available as untrusted resume context only for the same account, business and user. They remain incomplete observations, not approved facts or execution authority. A resumed turn can use them without repeating writes; no automatic worker continuation is implied.
- The authenticated `/api/dev/runtime` response includes a process instance ID, startup time and a launcher-computed API/contracts source fingerprint. It identifies uncommitted API source changes; it is not attestation of a remote bridge's loaded code. Production launchers that do not supply the fingerprint report null.

The subsequent durable request queue removes the long HTTP request dependency; see `agent-request-queue.md`. Still outstanding: automatic recovery of ambiguous in-flight work (without replaying effects), general intent-based tool discovery, tokenizer-aware provider-specific budgets, policy-controlled provider failover, and live provider failure/latency evaluations. These changes do not make the agent production-ready by themselves.

Rollout validation on 2026-11-04: migration 0074 applied locally, authenticated runtime metadata returned the new source fingerprint and startup identity, and a live general-chat request to the configured Gemini model completed through port 3000. A second read-only `/campaign-status` request completed with ANSWERED, three model steps, two tool calls (`read_marketing_campaigns`, `read_proposals`) and two persisted finding checkpoints. This verifies a short tool-use/answer path, not a long research run, outage recovery against a real provider, or autonomous campaign execution.

Tests: `agent-recovery.test.ts`, `agent-model.test.ts`, `agent-harness.test.ts`, and `agent-runs.integration.test.ts`. Fixture tests validate failure/recovery without live model calls. They do not establish that a particular provider is healthy.
