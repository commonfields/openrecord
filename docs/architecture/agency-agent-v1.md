# Agency agent V1 contract

The hosted assistant uses a dedicated Gemini `generateContent` conversation with registered function declarations. It does not use the external measurement adapter or its model configuration. The [Gemini function-calling API](https://ai.google.dev/gemini-api/docs/function-calling) defines the wire protocol.

## Configuration and external processing

The API requires explicit deployment consent before sending client evidence externally:

- `AGENT_EXTERNAL_PROCESSING_ENABLED=true`
- `AGENT_PROVIDER=gemini`
- `AGENT_MODEL`: one explicit Gemini model ID. There is no default or fallback.
- `AGENT_API_KEY`: separate assistant credential. The worker's measurement key is not reused.
- `AGENT_MAX_OUTPUT_TOKENS`: default 2048, maximum 4096 per inference.
- `AGENT_TIMEOUT_MS`: default 20000, maximum 30000 per inference.

Leave external processing disabled until the agency has authorized the provider to process its client evidence. This setting grants no measurement budget or publication authority. No test needs a real key.

Only user messages and selected scoped tool evidence enter the assistant provider request. Private reviewer and agency action notes, raw provider payloads, session cookies and secrets are excluded. Fact values, source URLs and observed answers can contain confidential client information; enabling the flag explicitly permits this bounded external processing. No upload path exists.

## Runtime and permissions

`agent-tools.ts` owns the eight read tools and their Effect input schemas. The same schemas generate the function declarations. The dispatcher rejects unknown tool names, excess properties and invalid IDs. Every read checks the active business against the session account. The tool audit logs names, scope and invocation timestamps, without evidence text or secrets.

`dispatchAgentTool` adds `propose_check_run`, which writes only a scoped pending proposal for a stored question. No model tool can approve, reject, publish, record a human judgment or execute a check. The existing proposal repository serializes human decisions and replays an executed check once. Pending proposals expire for approval after 24 hours. Live approval requires an enabled exact model from the server catalog.

Tool errors return a typed result to the model: `UNKNOWN_TOOL`, `INVALID_INPUT`, `NOT_FOUND`, `REFUSED`, `TOOL_FAILED`, `RESULT_TOO_LARGE` or `BUDGET_EXHAUSTED`, with whether a retry can help and what to do instead. Repository and decoder detail never leaves the server. See [Durable runs](#durable-runs-harness) for budgets, context and verification. Each tool result is at most 18000 characters and the transport accepts at most 256000 response bytes. There are no provider retries or substitutions. Oversized evidence requires a narrower read; it is never silently described as complete.

The system prompt treats messages, source text, observations, titles and metadata as untrusted data. Prompt wording is not the security boundary: the closed dispatcher and server permissions prevent approvals and execution even if the model follows an injected instruction. Free-form prose can still be mistaken and needs operator review.

## Conversation contract and retention

`0027_agent_conversations.sql` stores one private conversation per account, business and authenticated user. Client Record IDs are Business IDs, so both entry points use the same scoped endpoint. React keys isolate context changes and discard old asynchronous responses.

The server stores the latest 200 messages, tool summaries, evidence references, run references and latest reply metadata. The context builder decides what the model sees (see [Durable runs](#durable-runs-harness)). Raw provider payloads are never duplicated. Replies record requested and observed model identity and reported token counts; absent counts remain null. Conversation inference usage is separate from queued measurement usage. No price is invented from token counts.

POST requires a request UUID and revision. A two-minute lease prevents concurrent turns without keeping a database transaction open during inference. Completion checks the same lease; stale writers cannot replace newer messages. The latest request can replay its saved reply. Older revisions return 409 and never repeat writes. Failures release the lease.

Conversations expire 30 days after their last completed turn. Reads exclude expired rows. New sends remove expired conversations for the authenticated user. Operators can immediately delete their conversation, which also fences an in-flight completion. Deployment maintenance must periodically purge remaining expired rows with `DELETE FROM agent_conversations WHERE expires_at <= now()`; backups follow deployment retention policy. Deleting a conversation does not delete immutable observations or independently created proposals.

## Operator workflow

Open a client and expand **Investigate with the agent**, or open Business Overview. Ask about stored problems, reviewed findings or evidence. Use the application-rendered evidence links to inspect the underlying record. Unknown evidence remains unknown. Attachments are disabled; paste relevant text instead.

Ask for a re-check of a stored buyer question. Review the proposal, exact question and measurement model. Approval queues one measurement call; rejection does not execute. The UI states when estimated cost or a supported execution model is unavailable. Report generation and acquisition tools belong to subsequent deliverables.

## Evaluation boundaries

Run the `agent*.test.ts` and `agent*.integration.test.ts` suites with a disposable PostgreSQL 16 database and `TEST_DATABASE_URL`. Unit tests use deterministic model and HTTP response fixtures. Integration tests exercise real scoped repositories, leases and approval transactions. Web tests verify trusted evidence routing. Neither fixture tool selection nor canned prose proves a live model's referent resolution or unsupported-claim rate.

Before a separately authorized live evaluation, agree on one model and budget. Exercise the three-turn problem, evidence and proposal scenario on authorized data. Record actual tool selection, reference validity, unsupported claims, unauthorized actions, provider usage, price and latency. No live accuracy or latency claim is made by deterministic CI.

## Private actions and report snapshots (P2)

Migration `0028_agent_drafts.sql` extends the same proposal table with `DRAFT_SOURCE_ACTION` and `PREPARE_CLIENT_REPORT`. Both use PROPOSED, APPROVED and REJECTED. APPROVED means the operator accepts a draft. Neither kind can enter EXECUTED or hold an executed check. A REQUEST_CHECK cannot enter APPROVED without execution. The existing content-immutability trigger also protects the draft payload.

Source-action drafts require a currently approved Client Record item and at least one real observation for that item. The server supplies the fact, source location and observation references. The model supplies a proposed action, assumptions, uncertainty and a verification plan. The source URL is a location, not a new fetched page snapshot. Approval locks the same client row as record edits and revalidates the exact item version, so a superseded plan cannot be accepted against new truth.

Reports use the Record Repository's existing repeatable-read, read-only snapshot. The immutable proposal is saved after that read transaction ends; pending proposal summaries are read separately. The default period is the last seven days, end exclusive, selecting runs by their creation timestamp. Explicit periods are limited to 93 days. Per-run counts, reviewed outcomes and synthetic exclusions come from application code. No unreviewed finding becomes confirmed. The report includes only human-recorded actions, without private action notes. Pending proposals remain pending work. Current before-and-after comparisons can refer to evidence outside the report period; the text states this boundary.

The saved payload contains readable report text, evidence IDs, approved fact versions, observation digests, current judgment IDs, human action references, the generation timestamp and a SHA-256 digest of the evidence snapshot. New evidence cannot rewrite the saved snapshot. There is one pending report per business and one pending source-action draft per stored question. Repeated drafting returns that pending draft with its original timestamp. Accept or reject it before creating another snapshot.

The assistant receives a short saved-draft receipt. It cannot override the saved numerical sections with prose. Operators can read, copy, accept or reject the snapshot inside the existing chat. Draft acceptance never grants publication or delivery permission. There is no public report endpoint, no external site edit, and no automatic creation of completed agency work. Accepted drafts remain private authenticated proposal records and survive conversation deletion.

Acquisition observations and referrals require the independent acquisition workstream's published contracts. Until integrated, reports explicitly label those capabilities unavailable instead of inventing measurements or signups.

## Acquisition tools and measurement proposals (P1)

P1 consumes the committed Acquisition Pilot contract from PR #55. `AcquisitionRepository.snapshot` owns the data snapshot. `acquisitionView`, `batchMetrics` and `configurationDifferences` own measurement calculations. The agent adds five scoped read tools: acquisition overview, buyer-question results, competitor appearances, citation evidence and batch comparison. Private acquisition reviewer notes are excluded.

Recommendation counts retain the reviewed-eligible denominator. Mentions retain the acquisition contract's eligible-answer denominator, with review completeness reported separately. Competitor appearances are exact-name candidates, not independently verified aliases, human-reviewed recommendations or market share. Batch comparison additionally requires a single known matching observed model, correct time order and observed grounding when grounding was requested. Different, unknown or incomplete conditions produce NOT_COMPARABLE with reasons.

`propose_question_set` saves exact question text, intent groups, target, samples and a measurement plan. Accepting the text does not freeze a set or claim client authorization. The operator selects the authorization basis and freezes the reviewed set through the existing AI Discovery process.

`propose_acquisition_measurement` accepts only an existing frozen set. It records provider, exact requested model, samples, frozen-set digest and maximum calls including all four allowed provider attempts per sample. `AGENT_MEASUREMENT_MAX_USD_PER_ATTEMPT` is an optional deployment-supplied upper cost estimate including inference, grounding and retries. It is not a live provider quote. The proposal's estimate rounds up to cents. Missing or invalid pricing blocks approval. Synthetic fixture plans state that basis explicitly and still require the existing fixture gate.

The operator approves the exact saved plan and estimate through the authenticated UI. The server checks the current surface, frozen-set digest, budget, proposal age and scope before calling the existing `startBatch` API in the same decision transaction. Concurrent approvals and retries return the same batch. The model has no approval tool. A changed model or missing cost cannot silently substitute a provider or create a batch. Migration `0029_agent_acquisition_proposals.sql` preserves this execution identity and its business-scoped foreign key.

Stack order is #55 acquisition dependency, #54 core, #56 draft/report infrastructure, then P1 and P3. P2 preceded P1 because the acquisition contract was still being completed while the independent report infrastructure was built.

## Referral interpretation (P3)

`read_ai_referral_evidence` is a read-only, scoped tool. It verifies the account and business with `BusinessRepository.getScoped` before calling `AcquisitionRepository.snapshot(businessId)`, then derives every value through the acquisition read model (`referralSummary`, the same helper behind `acquisitionView` and `acquisitionReport`). The pure contract lives in `packages/db/src/agent-referrals.ts`; it adds no GA4 parser, attribution rule, migration or persistence.

Output is bounded and structured: import ID, data origin, property reference, full date range and day count, time zone, attribution basis, AI source rules version, import digest, AI-attributed and total reported sessions, per-assistant sessions with their source/medium labels, the configured conversion event and its total, signups, session and conversion leaders, assistants without attributed rows, a list of the latest 20 real imports, and limitations. Raw CSV text, row-level days and visitor identifiers never reach the model. Synthetic imports are excluded from every figure and cannot be selected by ID; foreign, synthetic and unknown IDs all read as not in scope.

Missing data stays missing. With no real export the tool returns `REFERRAL_DATA_UNAVAILABLE` (signups `SIGNUPS_NOT_MEASURED`, conversions `UNKNOWN`). An export without a configured event returns `SIGNUPS_NOT_MEASURED`, never zero. A configured event that is not a signup event (for example `purchase`) is reported as a configured conversion count with signups `SIGNUPS_NOT_MEASURED`; only `sign_up` (and spellings such as `signup`) yields a signup count. Events are not necessarily unique people.

Surfaces stay separate. The tool lists the measured recommendation surfaces (for example Gemini API with Google Search grounding) without any recommendation counts, and states that GA4 sessions attributed to ChatGPT, Claude, Gemini or other assistants are website traffic, not measured recommendations. Recommendation counts come only from the acquisition tools. The system prompt repeats these rules and forbids adding, extrapolating or recomputing totals and any causal link between recommendations, referrals, signups and agency work.

Descriptive comparison (`importId` with `beforeImportId`) requires the same property, time zone, attribution basis and conversion event, and ordered non-overlapping periods. It reports full-period totals, day counts and count differences; any mismatch returns `NOT_COMPARABLE` with reasons and no deltas. Exports are never summed or clipped.

Private client reports (`prepare_client_report`) add four distinct sections built deterministically from the same snapshot: AI recommendation evidence (acquisition batches created in the report period, with exact numerators and denominators, pending samples, provider attempts, the measured surface, and classified citation evidence), website referral evidence (full real exports overlapping the end-exclusive report window, with digest and per-assistant sessions), conversion evidence (configured event, totals and signups or "not measured"), and limitations (including the acquisition causality disclosure). There is no composite score. A report refuses an oversized selection rather than dropping evidence. Reports remain private drafts: no share, publication or delivery path is added.

No OAuth, analytics account access, tracker or public endpoint is added. The model still cannot approve, publish or execute. Evaluation is fixture-only: tests use deterministic model fixtures and TEST data; no live model was evaluated.

Report selection uses UTC calendar-day overlap for full GA4 export periods; it does not establish exact temporal alignment with recommendation measurements. The referral tool bounds the import index and measured-surface list to 20 entries, reports the full counts, and caps source-medium examples at 10 per assistant. The conversation runtime also refuses tool payloads above its existing context limit.

## First-improvement workflow

`/setup <request>` in a business chat runs the versioned first-improvement workflow with a narrowed toolset and a propose-only write. See [ECC-informed marketing skills V1](ecc-marketing-skills-v1.md).

## Durable runs (harness)

Every message is answered by a durable run (`0040_agent_runs.sql`). The run row records the conversation lease it executes under, the objective, the selected workflow and its terminal state: `COMPLETED` with an outcome of `ANSWERED` or `ANSWERED_WITH_GAPS`, or `FAILED`, `CANCELLED` or `INTERRUPTED` with a reason. An append-only journal (`agent_run_events`) records the built context, each model step with its usage, every tool invocation under a server-generated invocation ID, proposal receipts (IDs and states only, never evidence text), verification and the finish. Database triggers keep the journal append-only and a finished run final. Raw provider payloads and full tool evidence are not copied into the journal.

**Registry.** `agent-registry.ts` holds every tool once, with its declaration, effect (`read` or `propose`), replay safety and whether it is general or workflow-only. Dispatch is closed. No entry can approve, publish or execute. Every `propose` tool deduplicates on the server: a pending proposal of the same kind, or a server-derived key. The model no longer supplies the growth proposal `idempotencyKey`. The key is derived from the business and the canonical proposal content, so a retried or resumed run returns the saved opportunity.

**Budgets.** A general turn has 8 model steps and 12 tool calls. A workflow can declare its own budget (first improvement: 6 and 6). Calls beyond the budget return `BUDGET_EXHAUSTED`. The model then gets one final step with an instruction to answer from the evidence already read and state what was not checked. The answer is kept and marked `ANSWERED_WITH_GAPS`. A model that still calls tools ends with `TOOL_LIMIT`. The whole turn still times out at 540 seconds.

**Context.** `agent-context.ts` keeps the most recent messages verbatim (at most 16, within three quarters of a 32000-character history budget). Older messages are compacted deterministically, without a model call. Each earlier request, the tool work behind each answer and the evidence references stay available, so follow-ups such as "the second one" still resolve. The memory states how many older messages no longer fit. Within a run, once the request would exceed 64000 characters, the oldest tool results shrink to their summaries and references. The newest round stays complete; the run fails with `CONTEXT_LIMIT` only if that is still too large.

**Verification.** A workflow skill can declare completion criteria (`completion.requiredTools`). If the model answers before a required tool succeeded, it gets one reminder. If the tool still does not run, the answer is kept with the gap named (for example "Required step not run: diagnosing marketing problems") and the outcome is `ANSWERED_WITH_GAPS`. The UI shows gaps under the answer.

**Stopping and recovery.** A run ends early on cancel, a provider failure, a timeout or a crash. The run is then *settled* into the conversation, inside the same row lock that serializes turns. If the run did tool work, the conversation gains the request and an interruption note built only from the journal. The note states what was saved for review, which save was in flight and may not have completed, which evidence was read, and that no final answer was written. If the run did nothing, the conversation is unchanged and the message can simply be sent again. Settlement happens when the run stops, and again when the conversation is next read or sent to. A `RUNNING` run whose lease no longer holds becomes `INTERRUPTED`, so a process crash cannot leave saved work unexplained. Cancellation (the existing stop route) revokes the lease. The next guarded step fails with `CANCELLED`, which ends the run instead of appearing as missing evidence. A completed reply and its run's completion commit in one transaction.

**Progress.** `GET /api/agent/runs/progress?requestId=…&after=<seq>` returns the newest run for a request the signed-in user sent, plus journal events after a sequence number. Clients poll it while a reply is pending and resume from the last sequence they saw. Unknown and foreign requests read as `{ run: null, events: [] }`. The chat shows the running step ("Reading growth goal…") and the steps already completed.

**Evaluation.** `agent-harness.test.ts` covers the loop with deterministic fixtures: journal contents, typed failures, budgets, verification, compaction and interruption notes. `agent-runs.integration.test.ts` runs against disposable PostgreSQL. It saves a proposal, fails the provider before the reply, and checks that the conversation explains the saved proposal and that a retry reuses its identity. It also covers crash settlement, cancellation, scoped live progress and the HTTP route. These tests prove the harness contracts, not live model behaviour.

## Decisions in the chat

A proposal tool's receipt carries the ID of what it saved: an agent proposal (`proposalId`) or a growth initiative (`opportunityId`). The run loop collects these as decision references. The reply stores up to ten of them in `messages[].decisions`, and so does an interruption note built from the journal. The chat renders each reference as an approval card under the reply that created it: re-checks, drafts and measurement plans use the existing proposal cards, and initiatives use the setup flow's decision card. Deciding still goes through each item's own route, with the approver taken from the session. The model cannot decide, and a reference is only an ID, so a stale card reloads the current state.

`GET /api/decisions` returns everything waiting on the signed-in account across its businesses: `PROPOSED` agent proposals and `PROPOSED` initiatives, newest first. It is operator-only and `no-store`. The **Waiting on you** page (`/approvals`) lists the same items with the same cards, and the sidebar shows the count. The business **Work** page shows agent proposals inline instead of linking to the chat.

## Google Search Console (read-only)

Search Console uses the GA4 Google connection. Consent now asks for `webmasters.readonly` next to `analytics.readonly`. Google lets a person grant only some of the requested scopes, so either read scope is enough, and nothing broader is accepted (`0041_search_console_v1.sql` widens the stored-scope check the same way). A connection made before this change has no Search Console scope. **Channels** offers to add it to the same Google account, and re-consent keeps the connection's identity. The OAuth state records whether to return to measurement or to Channels.

`search_console_bindings` binds one Search Console site to one business. A site can be bound only if the connection lists it today; unverified sites are never listed. A domain property is marked when it covers the business's website. Rebinding ends the previous binding in the same transaction. Bindings are history: they end, and are never deleted while the business exists.

Performance is read live and not stored: totals for the last 7, 28 or 90 complete days (ending three days ago, when Google's data is complete) and the same-length period before, plus the top ten queries and pages by clicks. It is shown on **Results** and available to the agent through `read_search_performance`. The tool answers `NOT_CONNECTED`, `RECONNECT_REQUIRED` or `SITE_NOT_ACCESSIBLE` in words rather than zeros. Its result says these numbers cover Google Search only, and that a change between periods does not show its cause. `search-console.integration.test.ts` exercises consent, scopes, binding, tenancy, windows and the tool against the local Google stand-in, which is `MOCK_ADAPTER_PASS`, never a live Google result.

## Sessions that work together

A business session can start helper sessions and talk to other sessions, modelled on T3 Code's orchestrator (`delegate_task`, `task_status`, `task_cancel`, `t3_thread_send`, `t3_thread_read`, `t3_thread_list`, `orchestrator_capabilities`). The tools are declared in `apps/api/src/agent-session-tools.ts`; the runtime is `apps/api/src/agent-sessions.ts`; migration `0042_agent_sessions_v1.sql` adds the storage.

- `delegate_task` starts a helper session for one self-contained task, with an optional role (research, search, AI answers, content, measurement) and an optional model from `list_models`. The helper receives only the task, never the caller's history. Several calls in one model step run in parallel, at most three at a time.
- `message_session` runs a follow-up turn in another session of the same business, keeping that session's own history. A session cannot message itself or a session that started it, and a session that is working refuses the message.
- `read_task` and `cancel_task` act on tasks the calling session started. Cancelling stops the helper and every helper below it.
- `list_sessions` and `read_session` read the operator's other sessions for the same business. Their text is untrusted data, like any tool result.

**Wait and async.** In `wait` mode (the default) the caller's tool call returns the helper's result, bounded by the caller's own time limit. A helper still running when the wait ends keeps running. In `async` mode the call returns at once. Finished results are posted into the caller's session as messages. Once every task its turn started has finished, an idle caller continues with one automatic turn that combines the results. That turn cannot start new helpers, and cancelled tasks never start it.

**Boundaries.** A helper is an ordinary durable conversation with a parent, created archived so it never becomes the business's default chat. It belongs to the same account, business and user, and runs the same server-owned tools as its caller and nothing broader. A database trigger refuses a task whose sessions are outside that scope. A helper's proposals are ordinary pending proposals and appear as approval cards on the caller's reply. The server bounds the work:

- Depth: helpers of helpers are allowed, but a helper at depth 2 only reads.
- At most six tasks per turn.
- At most eight running tasks per account.
- A repeated `clientRequestId` returns the recorded task instead of starting a second helper.

A task whose helper lost its turn (restart or crash) is recorded as interrupted when it is next read. Messages that other sessions add do not count as operator turns (`user_revision`), so an operator whose screen predates them can still send.

**Verification.** `agent-sessions.integration.test.ts` runs the real loop, business tools and session tools against disposable PostgreSQL with a scripted model. It covers:

- parallel helpers, with their approvals reaching the caller;
- async results and the automatic continuation;
- Stop cascading to helpers;
- business scoping;
- deduplicated retries and the depth limit.

No live model has been run through these tools.

## What the chat shows while the agent works

A pending reply starts as **Thinking**. When the model runs a tool it switches to **Working**, showing the tool as a present-tense label, and returns to **Thinking** before the next step. A seconds counter runs throughout. When the provider returns its reasoning, the latest lines appear under the status as they stream, and each finished step stays listed with a check. The live trace is folded from the run journal (`apps/web/app/components/agent-trace.tsx`).

When the reply arrives, the trace folds into one line above the answer, for example "Thought for 12s · 3 steps". Opening it shows the model's reasoning for each step and every tool result. The trace is stored on the agent message as `activity` (at most 24 entries) and `durationMs`. It is never part of the history the model sees.
