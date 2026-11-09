# External repository and resource audit

Phase 0 audit for the objective lineage work (M1) and the proposed capability
registry (M1.5). Inspected on 2026-11-09 against OpenRecord `67f4b2a4ae83`.

Method: GitHub API metadata, license files and READMEs only. Nothing was
cloned into the checkout, installed, built or executed. Snapshots of the read
files were kept outside the repository. "Unverified" marks claims taken from a
project's own README that this audit did not test.

Automatic rejection rules applied to every repository:

1. no license;
2. unsandboxed arbitrary execution on tenant data;
3. duplicates OpenRecord state, authorization or tenancy;
4. solves a problem M1 to M3 does not have.

The default outcome is to adapt a pattern, not import a stack.

## Scorecard

| Repo (commit inspected) | Problem it solves | License | Activity | Runtime weight | Executes arbitrary code | Security model | OpenRecord part it would replace | Integration cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `goodnight000/api-anything` (`985ae8f65f4c`, 2026-11-08) | Learns a website's own XHR requests in a headless browser and replays them as an API over MCP, HTTP, a library or a CLI. A shared community catalog holds the learned specs. | MIT | Created 2026-09-27. 393 of about 412 commits by one maintainer. No releases. | Node 22.13+, headless browser, optional Python client, a shared catalog service | Yes. It drives a browser and runs site JavaScript as a fallback. Its specs come from a community catalog. | Runs locally. Cookies are stored as references and sessions are encrypted with the OS keychain. Writes are off by default, sent once, refused when duplicated and called applied only after a read-back (README, unverified). Catalog entries are trusted after calls from two other networks succeed. | Part of research ingestion (`apps/api/src/research/*`, 2204 capabilities). Not M1 to M3. | High. A browser runtime, a third-party catalog as a supply chain, and site terms-of-service review for each target. | **Reference.** Rules 2 and 4: browser execution against third-party sites on a hosted multi-tenant server, and lineage, binding and recovery need none of it. Two patterns are worth keeping: the `{class, reason, next}` failure envelope, and "applied only when a read finds the result", which OpenRecord already does for WordPress and account actions. |
| `t3dotgg/tstack` (`1085050f3bae`, 2026-10-28) | Coding-agent workflow skills: PR shipping, multi-model review councils, PR babysitting. | MIT | Created 2026-10-24. 5 commits, one author. | Markdown skills plus one Python script. Needs `gh`. | Instructions to a local coding agent. The `pr-wait` script runs locally. | Inherits the developer's harness permissions. | Nothing in the product. It is developer tooling. | Low for developers, none for the product | **Reject as a product dependency (rule 4).** It is a reference for how we work as engineers only, for example multi-model review before merge. Its push and merge automation conflicts with this project's "no push, no PR without authorization" rule. |
| `cursor/plugins` `pstack` (pinned `2776ddd2355d`, plugin v0.15.36) | A coding-agent methodology: reproduce first, playbooks, blinded skill evals, parallel subagents. | `pstack/LICENSE` is MIT (2026, Lauren Tan). The repository root has no license file; GitHub reports none. | Very active: last pushed 2026-11-07, 639 open issues. | Markdown skills, playbooks and automations | Directs coding agents. Its autopilot playbooks merge PRs unattended. | Inherits harness permissions | Nothing in the product | Low for developers | **Reference for engineering process only (rule 4).** Its "reproduce first, verify with runtime evidence" rule and its blinded eval playbook match how M1 is being run. The unattended merge playbooks conflict with the authorization gates here. Before copying any text, confirm that the MIT file covers the pinned subtree. |
| `superdesigndev/treg` (`029d214131aa`, 2026-11-09; release `v1.0.0-beta.1`, 2026-11-07) | A hosted tool registry: one token, a curated catalog of thousands of third-party endpoints searchable by task, credentials injected server-side, per-call billing, team-registered tools, CLIs and skills. | Apache-2.0 with **Additional Terms**. Clause 1 forbids using it, original or modified, to provide a hosted, managed or embedded service to third parties without written authorization. | Very active: about 4,000 commits from at least 5 contributors, 275 open issues | Python service, frontend, Alembic database, CLI, MCP surfaces | Yes. It runs registered vendor CLIs with injected credentials and relays third-party HTTP. | Server-side credential injection, read and write separated on its `/mcp/v2` surface. Prompts and arguments leave the tenant boundary for its relay and for third-party providers. | The capability registry and research provider routing. It would also add a second identity and billing system. | High, and license-blocked for OpenRecord's hosted product | **Reject the import** (license clause 1; rule 3, because it duplicates identity, credentials and billing; tenant data would leave through a third-party relay). **Adapt the pattern** for M1.5: search the catalog by task rather than vendor, separate read and write calls, inject credentials server-side and never hand them to the model, and attach a price class to every capability. |
| `affaan-m/ECC` (`d2ef2680594f`, 2026-11-06; release `v2.2.3`) | A large harness kit: about 300 skills, agents, hooks, a memory MCP server, and installers for many coding harnesses. | MIT | Very active, with many contributors. Has a security policy with an official-channels warning, because unofficial copies circulate. | npm package, Node hooks, MCP configs, Python dashboard | Yes. Its hooks are executable `node -e` scripts on harness events. | Its own docs say hooks and memory are not authorization boundaries. | Skills text; it overlaps the agent prompt layer | Already analysed at `25278e7`: see `docs/architecture/ecc-marketing-skills-v1.md` | **Keep the existing decision: adapt the pattern only.** Skill text is rewritten and pinned with provenance in `apps/api/src/agent-skills.ts`. Hooks, the memory vault and the installers stay rejected (rules 2 and 3). Re-pin when skill text is next adapted. Nothing new is needed for M1. |

## Engineering resources

"Applied" means used in the M1 or M1.5 design below. None of these become
dependencies.

| Resource | Principle taken | Evidence quality | Where it applies | Verdict |
| --- | --- | --- | --- | --- |
| Anthropic, *Effective context engineering for AI agents* | Treat context as a finite budget. Load tools and data just in time through lightweight identifiers. Keep tool sets minimal, without overlap. Keep notes outside the context window. | Practitioner guidance, not controlled experiments | M1.5 top-k loading. Recovery reads structured records, not chat history. | **Apply** |
| Anthropic, *Building effective agents* | Start with the simplest workflow. Invest in the agent-computer interface (clear tool docs, poka-yoke arguments). | Practitioner guidance | Manifest `when_to_use` and `when_not_to_use`. Lineage is set by the server, not passed as a model argument. | **Apply** |
| Liu et al., *Lost in the Middle* (arXiv 2307.03172) | Information placed mid-context is used less reliably than at the edges. | Peer-reviewed. Measured on 2023 models; current models are unmeasured here. | Argument against loading 71 schemas (about 79 KB) per turn. Keep the resume brief short and put it first. | **Apply as a hypothesis.** The OpenRecord tool-selection eval in M1.5 must confirm it. |
| Yao et al., *ReAct* (arXiv 2210.03629) | Interleave reasoning and actions, grounding each step in observations. | Peer-reviewed benchmarks | Already the shape of the server-owned tool loop (`runConversation`). M1.5 routes once per step, not once per conversation. | **Apply** (existing) |
| Jimenez et al., *SWE-bench* (arXiv 2310.06770) | Grade an executable outcome, not prose. | Peer-reviewed | Current `apps/api/src/evals` grade answer text only. M1 tests assert database rows. M1.5 capability evals grade persisted state and tool calls. | **Apply** |
| Model Context Protocol | Typed tool schemas, discovery and annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`). | Open specification | The manifest's `side_effect` maps to MCP annotations so `mcp-server.ts` can export them. Annotations are hints and never authorization. | **Adapt** |
| Fowler, *Patterns of Distributed Systems* (Unmesh Joshi) | **Idempotent Receiver**: identify each client request so retries are ignored. The linked catalog does **not** contain Transactional Outbox or Saga (checked 2026-11-09). | Pattern catalog | Already applied through request keys (`draft_key`, `request_key`, `agent_request_key`). For Outbox and Saga, use Richardson's microservices.io patterns as the reference in M3. | **Apply** Idempotent Receiver. Outbox and Saga: reference for M3, with the source corrected. |
| Stripe idempotent requests | Save status and body for the first execution of a key. Error when parameters differ. Do not save on validation failure or a concurrent conflict. Prune keys after 24 hours or more. | Production documentation | M1: a replayed creation returns the original row, and its lineage is never rewritten. M1.5: `idempotency_key` derivation is part of the manifest. | **Apply** |
| OpenTelemetry GenAI semantic conventions | Name spans and attributes for model and tool calls. | The linked page now says the conventions moved to a separate repository. Stability status was **not verified**. | M1.5 tracing uses `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name` and `gen_ai.tool.call.id` (from prior knowledge, **unverified** against the current spec). Durable receipts stay in `agent_run` tables. | **Adapt** after re-checking the moved spec |

### Tier 2 and 3: reference or deferred, not M1 dependencies

| Resource | Hypothesis it offers | Status |
| --- | --- | --- |
| MemGPT (2310.08560) | Tiered memory paged into context | Deferred. Structured SQL recovery comes first. |
| Zep / Graphiti (2501.13956) | Temporal knowledge graph memory | Deferred. Would duplicate state. Adopt only if it beats structured retrieval on whole-task evals. |
| GraphRAG (2404.16130), HippoRAG (2405.14831) | Graph-structured retrieval | Deferred. The same bar applies. |
| Generative Agents (2304.03442), Reflexion (2303.11366) | Reflection and lessons written back as memory | M2 and M4 reference. Lessons must bind to observed outcomes, not model self-critique. |
| Voyager (2305.16291) | A growing skill library | M1.5 reference only. A capability is enabled by eval cases, not by a model writing it. |
| DSPy (2310.03714) | Prompt and program optimisation against a metric | Deferred until whole-task evals exist. |
| tau-bench (2406.12045) | Grade agents by final database state under policy | **Model for M1.5 capability evals** (pattern, no dependency). |
| Temporal | Durable workflows with resume and cancel | M3 reference only. `agent-request-queue.ts` already fences claims. |

## Marketing fundamentals: what gets encoded, and where

These shape data structures and evals (M2 and later). M1 builds none of them.

- **Diagnosis before strategy before tactics** (Ritson; Rumelt's kernel:
  diagnosis, guiding policy, coherent action). A strategy is a versioned
  record: who, buying situation, why we win, how they are reached,
  constraints, and how progress is judged. Campaigns would reference a
  strategy version the way M1 makes them reference a goal.
- **The judgment test must be enforced.** Awareness problem: reach and
  distribution. Known but not bought: offer, price, trust or friction. Bought
  once but not returning: product experience, timing or CRM. The diagnosis
  type should restrict which intervention families a proposal may use. An eval
  fails when one playbook is used for all three.
- **Mental and physical availability** (Ehrenberg-Bass) and **brand versus
  activation** (Binet and Field) are judgment frames for the diagnosis,
  labelled as frameworks and not as proof for a given business.
- **Positioning from best-fit customers** (Dunford) feeds the "who" and "why
  we win" fields.
- **MMM tools (Meridian, Robyn)** are references for incrementality. Platform
  attribution is not incremental effect. Below the data volume MMM needs,
  "unproven" is the honest result.

## Competitors (studied, not rebuilt)

Named generically per repository policy: a CRM suite's campaign agent, a
warehouse-native AI decisioning product, and a product-analytics suite. All
three generate campaign plans or content and run experiments. None of that is
a moat for OpenRecord. The only candidate moat is a permissioned, verified
history of objective, decision, authorized work, delivery, outcome and lesson
that measurably improves later decisions. It is **not validated**. M1 is its
first structural precondition.

## Adopt, adapt, reject

| Decision | Item | Why |
| --- | --- | --- |
| Adopt (principle) | Idempotent Receiver and Stripe-style replay | Already in place. M1 keeps creation-time lineage immutable under replay. |
| Adopt (principle) | Grade persisted state, not prose (SWE-bench, tau-bench) | M1 tests and M1.5 evals assert rows and calls |
| Adopt (principle) | Just-in-time context and minimal tool sets (Anthropic) | M1.5 |
| Adapt | MCP annotations, OTel GenAI attributes | Manifest fields map onto them. They are never authorization. |
| Adapt | Task-first catalog search, read and write split, server-side credentials, price classes (treg pattern) | M1.5 router and manifest |
| Adapt | Failure envelope `{class, reason, next}`, read-back before "applied" (api-anything pattern) | Close to existing `status`, `nextActions`, `recovery` results |
| Keep | ECC as rewritten, pinned skill text only | Existing decision |
| Reference | pstack, tstack | Engineering process only |
| Reject (import) | treg | License forbids hosted embedding. It duplicates identity and billing, and tenant data would leave through its relay. |
| Reject (import) | api-anything | Browser execution on hosted tenants, a catalog as a supply chain, outside M1 to M3 |
| Reject (import) | ECC hooks, memory vault, installers | Executable hooks. A second memory system that is not an authorization boundary. |
| Defer | Graph and memory frameworks, DSPy, Temporal | They need to beat structured SQL on OpenRecord whole-task evals first |
