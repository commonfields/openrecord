# Local provider runtime

OpenRecord connects a user's local provider CLIs through an outbound bridge. The server keeps conversation ownership and application tool permissions. The bridge keeps provider credentials and local process ownership.

## Why the bridge runs locally

T3 Code runs provider drivers beside its server. OpenRecord's hosted server is not the user's computer, so running those CLIs on the hosted server would require transferring credentials. The local bridge avoids that transfer and needs no inbound port on the user's computer.

The design follows T3 Code's distinction between driver kinds, configured instances, provider discovery, and per-turn model selection. The reference checkout is `pingdotgg/t3code` at commit `375da0fb9a20dfdbd2eb2db99050341fc30f3a23`, under the MIT license. Useful reference modules are `packages/contracts/src/providerInstance.ts`, `packages/provider-core/src/server/ProviderAdapter.ts`, and the OpenCode and Cursor provider packages. OpenRecord implements its own transport and preserves its existing Effect 3 application loop.

## Why the server owns tools

A provider returns text or a bounded list of requested OpenRecord tool calls. The existing server loop validates and executes those requests. Reads retain tenant scope. Writes remain proposals that require the existing approval workflow.

Giving each local CLI a separate OpenRecord MCP grant would introduce another authorization path. This version does not need that path. The bridge runs providers in temporary workspaces, refuses ACP permission requests, and does not offer filesystem or terminal client capabilities. Codex and Claude also receive restrictive CLI options. These controls do not turn an installed third-party executable into an operating-system sandbox. Users must trust the CLI they install.

## Ownership and failure handling

Pairing binds a bridge to the signed-in user and account. The server stores hashes of pairing codes and bridge tokens. Operator mutations require a session and same-origin validation. Bridge routes use bearer capabilities, reject browser Origin headers, and recheck live account membership.

Migration `0037_harness_subscriptions_v1.sql` adds bridges, provider instances, and leased jobs. Composite foreign keys preserve account and user ownership. Jobs have monotonic terminal states. Claims use `FOR UPDATE SKIP LOCKED`; completion requires the correct bridge and lease. Disable, cancellation, and revocation invalidate active jobs. Late results cannot persist a conversation reply.

The server stores job input until completion, cancellation, or expiry cleanup. It erases input on termination. Polling removes terminal job receipts older than one day. Conversation history remains subject to its existing retention rules. Provider account labels and discovery status are private user data stored by OpenRecord, not provider credentials.

Request replay includes the selected instance and model in its digest. Switching models on a later turn sends bounded conversation history to the newly selected provider. There is no fallback and no automatic retry of an uncertain generation request.

## CLIProxyAPI driver

The fifth driver, `cliproxy`, is a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server rather than a CLI. The bridge lists its models with `GET /v1/models` and runs each model step as one `POST /v1/chat/completions` with native tool calling. The CLI drivers instead prompt the model to answer inside a JSON envelope. `packages/contracts/src/openai-chat.ts` converts OpenRecord's transcript (text, `functionCall` and `functionResponse` parts) to chat messages and back. Call IDs come from position, because the transcript stores none: the k-th call in model content i is `call_i_k`, and the server's responses that follow answer them in order.

The proxy's client key comes from an environment variable (`CLIPROXY_API_KEY` by default) or the private bridge configuration. Plain HTTP is accepted only for a loopback host. A 401 or 403 reports the instance as unauthenticated, a 429 as usage limited, and an unreachable proxy as not installed. Reasoning-effort options are not offered for this driver.

The bridge now runs up to four jobs at once, so helper sessions working in parallel are not queued behind one another.

A self-hosted server can also call CLIProxyAPI directly, without a bridge: `AGENT_PROVIDER=cliproxy`, `AGENT_MODEL=<model id>`, `AGENT_API_KEY=<client key>` and `AGENT_BASE_URL` (default `http://127.0.0.1:8317`; plain HTTP only on loopback).

## Current limits

The five drivers are Codex, Claude Code, OpenCode, Cursor and CLIProxyAPI. OpenCode and Cursor use ACP; CLIProxyAPI uses its OpenAI-compatible HTTP API. Discovery does not establish subscription entitlement. Provider-specific minimum-version compatibility and successful live generation still need validation before release.

Discovery rotates report batches below a 150 KB UTF-8 request budget. Individual catalogs are limited to 500 models and a 125 KB report budget. Settings marks a catalog that was truncated. Other account instances remain discoverable on later polls.

Replies are delivered after the bounded server tool loop completes. This version does not stream token deltas or resume native CLI threads. A process or connection failure ends the attempt instead of transparently replaying it.

Each provider job has a 100-second server deadline and a 90-second local execution timeout. The server bounds a whole turn at 540 seconds, with a 600-second conversation lease. Deployment proxies and HTTP clients must allow that request duration. Cancellation checks run during generation and before application tool calls. Cancellation cannot undo a tool action that already completed or a provider's usage charge.

The web build bundles `packages/bridge/src/main.ts` into the downloadable `/openrecord-bridge.mjs`. The bridge uses Node 24, stores its capability in a private local file, and opens only outbound HTTPS connections. Loopback HTTP is permitted for development.

Setup instructions are in [Connect your local AI subscriptions](../operations/connect-local-agents.md).

## Verification boundaries

The bridge tests run fixture executables for all four drivers and a child bridge process against a local HTTP fixture. They do not prove live provider entitlement. The API integration tests run against disposable PostgreSQL and cover ownership, claim and completion races, cancellation, selected-model history, replay, and server-owned tool dispatch.

`packages/db/src/harness-migration.integration.test.ts` creates its own loopback databases, checks fresh installation and a populated pre-0037 upgrade, verifies replay, and removes only those databases. It requires `TEST_DATABASE_URL` and a test role with database-creation permission.

Run the focused gates from the repository root with that test environment configured:

```sh
pnpm --filter @openrecord/bridge test
pnpm --filter @openrecord/api exec vitest run src/harness.integration.test.ts src/agent-conversations.integration.test.ts
pnpm --filter @openrecord/db exec vitest run src/harness-migration.integration.test.ts
pnpm --filter @openrecord/web test
pnpm --filter @openrecord/web build
```

Local discovery succeeded for Codex 0.163.0 and OpenCode 2.1.4. Claude Code 2.1.310 reported signed out, and Cursor was not installed. The attempted OpenCode free-model generation returned `RATE_LIMITED`. No successful live-generation claim follows from these checks.
