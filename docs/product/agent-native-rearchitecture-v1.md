# Agent-native rearchitecture v1

This document records what OpenRecord actually does today (verified in code on `origin/main` at `6d39f69`), the product decisions made in PR 1, and the architecture for the work that follows. Each section is labelled **Current**, **Decision** or **Future** so the three are never mixed.

## 1. As-built audit (Current)

### What exists and is reused

| Capability | Where | Reused by PR 1 |
| --- | --- | --- |
| Accounts, businesses, sessions | `packages/db/migrations/0001_init.sql`, `packages/db/src/auth.ts` | Every setup row is scoped to one account and business. |
| Client records (`record_profiles`) | `0022_client_record_v1.sql`, `RecordRepository.createClient` | Setup creates or adopts a client, so every set-up business is one identity on both sides. |
| Authoritative facts with versions | `authoritative_facts`, `FactRepository.create` and `supersede` | Facts the operator ticks in the brief. A corrected value supersedes, never overwrites. |
| Growth goal and metric definition | `GrowthRepository.saveProfile` (idempotent by key) | The confirmed goal. |
| Initiatives with a human-only decision | `GrowthRepository.create(actor "ASSISTANT")`, `decide` (operator only, enforced by API and trigger `0030`) | The first initiative. |
| SSRF-safe fetching | `safeFetch` (`packages/representation/src/safe-http.ts:325`) | The one homepage read. |
| Page evidence extraction | `extractPageEvidence` (`packages/site-operator/src/inspect.ts:52`) | Extended by a sibling pure function for identity, headings, pages and profile links. |
| Durable worker jobs | per-table claim loops (`apps/worker/src/runner.ts`) | Setup discovery uses the `assay_sources` claim-token pattern. |
| GA4 OAuth, read-only measurement | `packages/ga4`, `growth_ga4_connections` | Read for channel state. |
| GitHub connected execution | `packages/site-operator/src/github.ts`, `growth_execution_targets` | Read for channel state. |
| Agent conversations and tools | `apps/api/src/agent*.ts` | Unchanged. Commands run beside it. |
| Today analytics | `apps/web/app/routes/today.tsx` | Becomes the Results area. |

### Why `/clients` and `/businesses` felt like two applications

They share one shell. The split came from three things:

- **The sidebar follows a remembered business.** Its business section rendered from `localStorage` (`openrecord:last-business`, `apps/web/app/lib/workspace.tsx:86-89`).
- **Client pages never set the active business.** So on `/clients/X` the sidebar could describe a different business.
- **Separate create paths.** A business made by "New business" (`POST /api/businesses`) had no `record_profiles` row and never appeared under Clients. A client made under Clients appeared in both.

The root `/` redirected to `/clients`, which is empty for a business owner (`main.tsx:60`).

### Form-driven experiences

Before getting any value, a new user filled one of these:

- **Client dialog:** 3 fields.
- **Growth profile:** 10 to 11 fields, including metric source and time zone.
- **Two-step initiative form:** 9 to 10 fields.
- **Three fact slots:** 6 fields each.
- **Product intake:** about 14 fields.

### Agent

- **Model:** global, configured by environment, Gemini only (`apps/api/src/agent-model.ts:42`). Without `AGENT_API_KEY` chat returns 503. There is no fallback model.
- **Tools:** 15 read tools. The proposal tools are `propose_growth_opportunity`, `propose_question_set`, `propose_acquisition_measurement`, `draft_source_action`, `prepare_client_report` and `propose_check_run`.
- **Approval:** no tool approves anything. Approval routes take the approver from the session.
- **Prompt-injection posture:** tool results are wrapped as `untrustedEvidence` and the system prompt names website text as untrusted (`apps/api/src/agent.ts:28,92`).
- **Slash commands:** none.

### Integrations that genuinely connect

| Integration | Auth | Reads | Executes | Verifies | Measures |
| --- | --- | --- | --- | --- | --- |
| GA4 | Google OAuth, PKCE, encrypted tokens | properties, key events, daily reports | nothing | not applicable | daily key-event counts |
| GitHub | one server-wide token plus a repository allowlist | repository, files, PRs | one operation: remove an accidental `noindex` via a PR, never merged | read-back of the merged file plus a live page check | no |
| Gemini, 9Router | API keys | AI answers (check runs) | no | no | no |

Search Console is not connected: the provider always reports missing credentials and the route returns fixture data (`packages/site-operator/src/gsc.ts:52-71`). *(Superseded: read-only Search Console performance now runs through the GA4 Google connection. See "Google Search Console" in `docs/architecture/agency-agent-v1.md`. The site-operator fixture provider is unchanged.)*

**Ledger-only channels.** `EMAIL`, `PAID`, `SOCIAL`, `THIRD_PARTY_PROFILE` and `OTHER` exist only as growth-ledger categories (`packages/contracts/src/growth.ts:99`). Nothing reads, posts to or measures them.

### Human approval is required for

- creating or changing authoritative facts;
- deciding initiatives (propose to approved or cancelled, review);
- approving agent proposals;
- connecting GA4;
- approving and applying website fixes;
- publishing reports and share links.

### Compatibility constraints

- **Public capability URLs:** `/open/:publicId` and `/reports/:publicId`.
- **GA4 OAuth callback:** redirects to `/clients/:id/growth-measurement`.
- **Evidence deep links:** `/businesses/:id/issues/:claimId`, `/representations/:bindingId`, `/search/sites/...` and `/observations/:id`.
- **Stored chat links:** `/businesses/:id/overview?view=agent` and `/clients/:id?agent=1`.

## 2. Product decisions (Decision, PR 1)

1. **One business workspace with four areas.** `/businesses/:id/agent`, `/channels`, `/work` and `/results`. The specialist views (website checks, AI answer issues, facts on the web, approved facts, AI answer checks, prospect research) keep their routes under a folded "Evidence tools" group. `/overview` becomes a redirect honouring `?view=`.
2. **Agent-first entry.** `/` opens the last business's agent, or `/start` when the account has none. `/start` asks for a website and an optional goal, nothing else.
3. **`/setup` is an application workflow, not a prompt.** It is a server state machine whose step is derived from stored state: Discover, Confirm, Connect, Propose, Done. It works with no model configured. A model never decides a step.
4. **One table, `business_setups` (migration 0036).** One row per business. It doubles as the discovery job and is unique per account and website host. A trigger keeps recorded discovery immutable and stops a setup naming another account's business.
5. **Website content is data.** The homepage is read once, in the worker, through `safeFetch` (8 s, 1 MB, HTML only, five redirects). Text is collapsed to one line and clipped, then shown as "suggestions, not verified". Nothing becomes a fact until the operator ticks it.
6. **The first initiative is rule-based and bounded:** remove an accidental `noindex`, then identify the business in structured data, then write a title and description, then publish answers to buyer questions. It is created as an assistant proposal, so only a human can approve it.
7. **Honest channel inventory.**
   - **Capabilities:** each provider declares the ones it implements (DISCOVER, READ, PROPOSE, EXECUTE, VERIFY, MEASURE) in one table (`apps/api/src/channels.ts`).
   - **States:** discovered, connected, permission required, unsupported, revoked, unhealthy.
   - **Ledger names grant nothing.** Profiles linked from a homepage are "found" with no Connect button.
   - **AI answer checks are listed as an OpenRecord instrument, not a connected channel.** Configuration only declares a provider, so the entry shows the date of the last real answer instead.
8. **Typed chat commands.**
   - `/setup`, `/status`, `/plan` and `/report` render deterministic cards from existing reads.
   - Exact phrasings such as "where are we?" map to the same commands. Anything else goes to the conversational agent.
   - A command never reaches the model, so commands work when no model is configured.
9. **Results answers five questions:** what we did, what was independently verified, what changed in measured numbers, what is still unknown, and what to do next. There is no composite score. A change over time is described as not showing cause.

**Tradeoffs.**

- **Setup measures the goal from manual daily exports by default.** The metric definition is immutable, so binding GA4 later means saving a new goal version. This avoids asking for a GA4 property during onboarding.
- **The homepage read follows the site-inspection precedent:** one owner-requested fetch, no robots.txt refusal. Discovery's crawl policy, which fails a whole run when robots.txt is unavailable, would block onboarding for many small sites.
- **Facts offered in setup are limited** to contact details found in structured data or `mailto:` links. Anything richer would need a model to extract it, and setup must work without one.

## 3. Agent harness architecture (Future)

### Official constraints (researched 2026-10-25)

- **Claude Agent SDK.** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Products use API keys or a cloud provider ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).
- **Codex app-server.** It runs as a local child process over stdio JSON-RPC. A client authenticates with an API key, or with an OAuth access token authorized for the user's ChatGPT plan that the app supplies to the child process ([Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)).
- **OpenCode.** `opencode serve` runs a local HTTP server (default `127.0.0.1:4096`) protected by HTTP basic auth via `OPENCODE_SERVER_PASSWORD`. Provider credentials are configured separately, and MCP servers can be added at runtime (`POST /mcp`) ([OpenCode server](https://opencode.ai/docs/server/)).

**Consequence.** A hosted OpenRecord cannot use a subscription that is authenticated on a user's machine. Bring-your-own runtimes run locally, through a provider-supported bridge, or with the user's API key. OpenRecord never collects CLI credential directories or browser session tokens.

### Separation of concerns

| Layer | Owns | Never owns |
| --- | --- | --- |
| OpenRecord application | business context, setup and approval state, evidence, audit | model choice, model output as authority |
| Agent runtime (hosted, Codex, OpenCode, Claude Agent SDK) | conversation, model calls, tool invocation | approvals, credentials for marketing providers |
| MCP interface | authenticated, business-scoped tools (§4) | SQL, files, shell, secrets, approval |
| Execution services | authorized mutations only (today: GitHub noindex removal) | deciding what to execute |
| Evidence services | receipts, observations, measurements recorded independently of the agent | trusting a runtime's report of what happened |

### Contracts

- **Runtime selection.** `{ runtime: "hosted" | "codex" | "opencode" | "claude-agent-sdk", transport: "server" | "local-bridge" }`. It is chosen per user, and the default is the hosted runtime when one is configured.
- **Identity.** Every runtime session runs under an `McpGrant` (`packages/contracts/src/mcp.ts`): user, account, business, permissions, runtime, expiry, revocation.
- **Authentication.** Hosted runtimes use the server's API key. Local runtimes use the user's own credentials, which stay on the user's machine. OpenRecord receives only grant-scoped tool calls.
- **Conversation and task lifecycle.** States are `queued → running → waiting_for_approval → completed | failed | cancelled`. A task stores its grant, runtime, start and end times, and the tool calls it made.
- **Streaming events.** `message.delta`, `tool.call`, `tool.result` (marked `untrusted: true` for observed data), `approval.requested`, `task.status` and `error`.
- **Tool invocation.** It goes only through the MCP tools in §4. Each call is checked against the grant at call time, not at session start.
- **Approval requests.** A tool can only create a proposal. Approval happens in the OpenRecord UI by a signed-in operator, and the runtime sees the outcome through `get_approval_status`.
- **Cancellation and recovery.** Cancelling stops the runtime task. Proposals already created stay as proposals. Resuming re-reads application state rather than replaying the transcript.
- **Audit and usage.** Every tool call records grant, tool, input digest, result size and latency. Runtime token usage is recorded when the runtime reports it.
- **Errors and limitations.** Results are typed: `UNAVAILABLE`, `REFUSED`, `NOT_IN_SCOPE`, `RATE_LIMITED`. Runtime-specific limits are surfaced, never hidden.

## 4. MCP boundary (Future, contract delivered in PR 1)

The tool table and grant check live in `packages/contracts/src/mcp.ts`, tested by `packages/contracts/src/mcp.test.ts`. Tools:

- `get_business_context`
- `get_goal_and_metric`
- `list_channel_capabilities`
- `list_evidence`
- `list_work`
- `propose_initiative` (the only writing tool, and it writes a proposal)
- `get_approval_status`
- `get_results`

The test fails if any tool name suggests SQL, files, a shell, credentials, approval, publishing, deletion, merging or deployment. It also fails if a proposing tool doesn't need the propose permission. No endpoint is served in PR 1. PR 2 implements the server behind authentication with per-grant revocation, and keeps it off public routes until its acceptance tests pass.

The external agent skill is `docs/agent/openrecord-skill/SKILL.md`. It explains how to use the tools and holds no business facts, credentials or permissions.

## 5. Sequencing (Future)

1. **PR 2: governed external access.** The MCP server for the contract above, grant issuance and revocation in the UI, and a compatibility test with Codex app-server and OpenCode over a local bridge.
2. **PR 3: one connected execution adapter.** Chosen after a capability and permission assessment. The candidate with the clearest read-back is structured-data publishing through the existing GitHub path, because it verifies the first initiative setup proposes.
3. **PR 4: one embedded BYO runtime,** with stream transport, cancellation, isolation and the approval bridge.
