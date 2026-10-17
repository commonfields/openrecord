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

Tool errors return an explicit unavailable result. The assistant has at most six tool calls and five inference rounds per turn. Each inference receives at most 64000 context characters, each tool result at most 18000 characters, and the transport accepts at most 256000 response bytes. The full turn times out after 90 seconds. There are no retries or provider substitutions. Oversized evidence requires a narrower read; it is never silently described as complete.

The system prompt treats messages, source text, observations, titles and metadata as untrusted data. Prompt wording is not the security boundary: the closed dispatcher and server permissions prevent approvals and execution even if the model follows an injected instruction. Free-form prose can still be mistaken and needs operator review.

## Conversation contract and retention

`0027_agent_conversations.sql` stores one private conversation per account, business and authenticated user. Client Record IDs are Business IDs, so both entry points use the same scoped endpoint. React keys isolate context changes and discard old asynchronous responses.

The server stores the latest 24 messages, tool summaries, evidence references and latest reply metadata. The model sees at most the last 12 messages. Older messages leave the bounded window. Raw provider payloads are never duplicated. Replies record requested and observed model identity and reported token counts; absent counts remain null. Conversation inference usage is separate from queued measurement usage. No price is invented from token counts.

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
