# ECC-informed marketing skills V1: first improvement

One customer journey: in a business's agent chat, the operator types

> `/setup Analyze my business and prepare the first marketing improvement.`

The agent diagnoses the business from recorded evidence, picks one problem, explains it, and saves one concrete improvement as a **PROPOSED** growth opportunity. A person approves or declines it in Work. Nothing is executed, published or measured by the agent.

A bare `/setup` is unchanged: the web app handles it as the deterministic setup card, and it never reaches a model.

## Baseline

| Item | Value |
| --- | --- |
| OpenRecord baseline | `02ba6e2` (main, after PR #83). PR #80 (agent-native setup) and PR #82 (harness subscriptions) are both merged, so this work does not depend on an open branch. |
| ECC inspected | `affaan-m/ECC` at `25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b`, package `ecc-universal` 2.2.3, MIT. |

## What already existed and was reused

- **Server-owned tool loop** (`agent.ts` `runConversation`). Providers return text or requested tool calls, and the API executes every tool. The hosted Gemini adapter (`agent-model.ts`) and the bridged Codex, Claude Code, OpenCode and Cursor harnesses (`harness-model.ts`, `packages/bridge`) all go through it. The bridge disables local files, shell and MCP for every harness. Provider portability was already a property of the transport, so no new adapter was written.
- **`/setup` evidence.** The worker reads the homepage once through its SSRF-guarded fetch and stores the result as `DiscoverySignals` with a body digest. The confirmed brief, the facts the operator ticked and the growth goal are stored too.
- **Setup's website rules** (`setup-plan.ts`). They now carry stable keys (`homepage.noindex`, `homepage.organization-data`, `homepage.snippet`) and are shared with the diagnosis. Setup behaviour is unchanged.
- **Human-reviewed AI answers.** These are current `CONTRADICTED` judgments on non-synthetic observations.
- **`GrowthRepository.create(actor ASSISTANT, PROPOSED)`.** It handles idempotency keys, observed-reference validation and the operator-only approve and cancel routes.

## ECC assessment

| ECC surface | What it actually is at the pinned commit | Decision |
| --- | --- | --- |
| `skills/*/SKILL.md` (311) | Markdown instructions with frontmatter. Most portable unit. | **Adopted as a pattern.** Three OpenRecord-owned skills with rewritten text. |
| `agents/marketing-agent.md`, `seo-specialist.md` | Persona prompts that declare `Read, Grep, Glob, WebSearch, WebFetch`. | **Pattern only.** Their tool grants are rejected; OpenRecord tools are closed and server-checked. |
| `skills/seo`, `market-research`, `brand-voice`, `marketing-campaign` | Checklists and output contracts. | SEO priorities (blockers before snippets, title and description lengths, schema must match visible content) are condensed into `seo-assessment`. Untrusted-source and "fact vs inference" rules are condensed into the workflow. Campaign suites, keyword research and voice capture are **out of scope** for one improvement. |
| `skills/agent-harness-construction` | Action-space guidance: narrow tools, `status/summary/next_actions`, recovery hints, context budgeting. | **Adopted.** Tool results carry `status`, `nextActions` and `recovery`. |
| Context profiles (`docs/design/context-profiles.md`) | A read-only plan generator; "grants no authority", "no task classifier" yet. | **Adopted the principle** (selection ≠ authority) as server-side progressive loading. |
| `hooks/hooks.json` | Executable `node -e` scripts on harness events. | **Rejected.** Hooks are not a permission boundary and would execute code. None imported. |
| Unified memory / `ecc-memory-mcp` | A local Markdown vault on the filesystem, explicitly "not an authorization boundary". | **Rejected.** OpenRecord's multi-tenant database stays authoritative, and no second memory system is added. |
| `.codex-plugin`, `.claude-plugin`, `.opencode` | Packaging for installing ECC into a harness, including MCP configs. | **Rejected.** OpenRecord does not install anything into user harnesses. |
| Cross-harness matrix | Codex is "instruction-backed", OpenCode is "adapter-backed", Claude is "native". | Confirms that capabilities differ by harness, so OpenRecord relies on none of them: skills are server-applied text plus server tools. |

No ECC file, script or dependency is vendored. The skill text is a rewritten adaptation. Provenance (`ECC_PIN`, `adaptedFrom`) is kept in `apps/api/src/agent-skills.ts` per MIT attribution. Nothing executable from ECC needs a security review because nothing executable was imported.

## Design

**Registry** (`agent-skills.ts`) is OpenRecord-owned and versioned. It holds one workflow and two specialists:

| Skill | Kind | Tools | Max effect | Evidence |
| --- | --- | --- | --- | --- |
| `first-improvement` v1 | workflow | `diagnose_marketing_problems`, `read_business_truth`, `read_issue`, `propose_first_improvement` | propose | website read, brief, goal, facts, reviewed answers |
| `seo-assessment` v1 | specialist | `diagnose_marketing_problems` | read | website read, brief |
| `answer-accuracy` v1 | specialist | `diagnose_marketing_problems`, `read_issue` | read | reviewed AI answer, approved facts |

**Selection.** `selectWorkflow` matches only an explicit `/setup <request>`. The specialist is then chosen deterministically by `diagnoseMarketing` from evidence, not by the model and not by page text. Priority:

1. Homepage `noindex` (critical).
2. A human-confirmed wrong AI answer.
3. Missing Organization data.
4. Missing title or description.

With no supported candidate, the status is `INSUFFICIENT_EVIDENCE` or `NO_SUPPORTED_PROBLEM`. There is deliberately no generic fallback such as setup's "publish an FAQ" hypothesis.

**Progressive loading.** A workflow turn declares only its four tools and appends only the workflow text. Specialist guidance enters the context inside the diagnosis result, and only for the selected problem. Measured with `turnPlan`:

| Turn | Tools | Tool declaration chars | System chars |
| --- | --- | --- | --- |
| Default chat | 22 | 15,635 | 3,957 |
| `/setup <request>` | 4 | 2,430 | 5,092 (+ ≤443 guidance after diagnosis) |

**Enforcement is server-side.** `handleAgentMessage` refuses any tool not declared for the turn, so an undeclared name fails closed even if the model asks for it. `diagnose_marketing_problems` and `propose_first_improvement` re-check `BusinessRepository.getScoped` against the session account. The propose tool accepts only `{ candidateKey, proposedChange }` and rejects excess properties. The server re-runs the diagnosis and supplies the title, problem, target page, evidence and uncertainty. A key that is not current is refused with a recovery instruction.

**Provenance and identity.** The proposal's `MODEL_SUGGESTION` note records:

- the workflow and specialist versions;
- the inference provider and requested model (for example `gemini gemini-fixture` or `codex codex-fixture`);
- the homepage URL, read time, body digest and failed check.

Answer-based proposals also carry validated `OBSERVED` observation references. Conversations already record provider, model and harness instance per reply, and replies now include `workflow: { id, version }`.

**Duplicates.** The idempotency key is derived from business, workflow version, candidate and evidence. A diagnosis also links an open opportunity with the same rule title, such as the one `/setup` itself proposed. Retries and provider switches therefore return `ALREADY_PROPOSED` and write nothing.

**Execute and verify.** The agent stops at a reviewable proposal. Approval stays on `POST /api/growth/clients/:id/opportunities/:id/approve` (operator only), and approval records no execution. No publishing integration was added, and outcomes stay unmeasured until existing measurement records them.

## Provider portability

| Capability | Hosted Gemini | Bridged Codex / Claude Code / OpenCode / Cursor |
| --- | --- | --- |
| Workflow instructions and tools | Native function declarations | Serialized into the bridge prompt; harness answers in the bridge JSON schema |
| Tool execution | Server | Server (bridge never executes tools) |
| Local files, shell, MCP, credentials | None | Denied by bridge config; never sent |
| Limits | 64,000 chars per inference | Same loop, plus 16,000-char system and 100 KB job caps (workflow system: 5,092 chars) |
| Reasoning effort | n/a | Codex and OpenCode only, as before |

Switching providers changes only the next turn's transport. Business facts, setup, evidence and proposals are read from the database on every call, and no harness state, credential or local file transfers between providers. Live parity of model *judgment* is not claimed.

## Evaluation

Run these with a disposable PostgreSQL 16 database and `TEST_DATABASE_URL`. They use deterministic fixture models and a `fetch` stub that refuses every host but the Gemini endpoint.

| Required check | Test |
| --- | --- |
| 1. Correct skill selection | `agent-skills.test.ts` (noindex → `seo-assessment`, reviewed wrong answer → `answer-accuracy`); integration answer-accuracy case |
| 2. Facts used, no invented claims | Proposal title, problem and target are server-built from the brief and evidence; model text limited to `proposedChange` |
| 3. Missing evidence → honest uncertainty | Unit cases for insufficient evidence and no supported problem; integration case for no setup, failed read and unconfirmed brief |
| 4. Malicious website text | Hostile homepage cannot change candidates; e2e fixture model "obeys" the page and calls an undeclared tool, which is refused |
| 5. Cross-account | Integration case: foreign session gets `AgentNotInScope` and writes nothing |
| 6. No publish without authorization | E2E: proposal is `PROPOSED` by `ASSISTANT`; approval only via the operator route; zero executions |
| 7. Evidence references preserved | Website digest and check in the note; `OBSERVED` observation reference; citations returned |
| 8. Two provider adapters, one contract | E2E through `handleAgentMessage` with the Gemini adapter and with a Codex harness via the real bridge job queue |
| 9. Provider switch keeps durable state | Database snapshot identical before and after the Codex turn; origin note still says Gemini |
| 10. Failed tools → truthful status | Invalid input fails closed as "unavailable or refused"; stale candidate refused with recovery; retries idempotent |

**Not proven.** These checks show contract-level behaviour only, using fixture models: no live Gemini, Codex or Claude model was run. They do not show that a live model chooses the right call, writes a good change, or avoids unsupported prose. That needs an authorized live evaluation with an agreed model and budget.

## Limitations

- Website evidence is limited to the homepage read stored by `/setup`. Drift of published facts (representations) is not yet a candidate, because its evidence has no growth reference kind.
- Website evidence is recorded as text in the proposal note, not as a typed reference, because growth evidence has no website-read kind. Adding one needs a migration.
- The chat UI renders the reply, tool summaries and citations as before. There is no dedicated proposal card yet; the proposal is reviewed in Work.

## Follow-up decision: an external OpenRecord skill or MCP for ECC-enabled agents

`packages/contracts/src/mcp.ts` already fixes a grant-scoped tool contract (`get_business_context` … `propose_initiative`), and `docs/agent/openrecord-skill/SKILL.md` describes it. Nothing is served yet.

- **For.** Customers already working in Claude Code, Codex or OpenCode with ECC could read approved context and evidence and submit proposals without opening OpenRecord. `diagnose_marketing_problems` and `propose_first_improvement` map directly onto `list_evidence` and `propose_initiative`.
- **Against or required first.**
  - Grant issuance, revocation and per-grant audit do not exist.
  - An external harness would run with the user's local tools enabled, unlike the bridge, which disables them. Every value OpenRecord returns would then sit beside a shell and the user's files, so returned website text becomes a higher-risk prompt-injection surface.
  - Rate limiting and token scoping need design.
- **Recommendation.** Not this iteration. When it is built, serve exactly the existing `MCP_TOOLS` contract, backed by these same functions, with `propose` as the strongest effect.
