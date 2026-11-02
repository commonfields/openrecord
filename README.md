# OpenRecord

[![CI](https://github.com/commonfields/openrecord/actions/workflows/ci.yml/badge.svg)](https://github.com/commonfields/openrecord/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/commonfields/openrecord)](LICENSE)

**An agent workspace for understanding a business, finding opportunities, and tracking marketing work and evidence.**

OpenRecord starts with a business website and an agent conversation. It brings public research, AI-answer monitoring, connected channels, proposed work, and results into one workspace. It is designed for people running their own businesses and agencies working across clients and products.

The agent can investigate and suggest work, but a suggestion is not a completed change, an account connection is not permission to do everything, and a change in a metric is not proof of causation. Capabilities depend on the configured providers, permissions, and available evidence.

## How it works

1. **Start with a website.** Add a business and tell the agent what you want to achieve. Website discovery and a draft brief help establish context; the user can review and correct it.
2. **Research and plan.** The agent can inspect public information, research businesses and markets, review AI answers, and propose next steps using the tools available to it.
3. **Connect what is useful.** Channels expose supported account connections and their permissions. Availability depends on deployment configuration and the accounts connected for the business.
4. **Review decisions.** Proposals that need a person appear in the inbox. Approval records a decision; what happens next depends on the specific action and integration. No approval should be mistaken for proof of publication or business impact.
5. **See work and results.** Review available performance data, activity, evidence, and outcomes. Some workflows still require manual input, account selection, or follow-up.

## Workspace

- **Agent** — conversations, research, proposals, and ongoing work for a business.
- **Inbox / Needs you** — decisions awaiting human review across businesses.
- **Results** — available AI-answer, search, advertising, revenue, and other measurements, with their sources and limitations.
- **Channels** — connect or manage supported services, inspect connection status, and understand what access is granted.
- **Businesses and clients** — switch between businesses, agency clients, and products. Existing records and shared reports retain their own evidence and access rules.

The underlying evidence tools remain available for work such as inspecting websites, reviewing AI-answer claims, maintaining approved facts, and rechecking sources. Public client records and reports can be shared through revocable links where configured.

## Research, AI, and integrations

- **Research catalog:** the agent can discover and call OpenRecord's defined research capabilities, including website and company research, search and SEO data, social and advertising research, AI visibility, and traffic signals. The catalog includes generated read-only API operations; a listed operation is not proof that a provider is configured or that a particular request will succeed.
- **AI answers and evidence:** collect configured provider answers, retain source and model information when available, compare claims with approved facts, and recheck outcomes. Mock answers are synthetic and cannot establish a real-world correction.
- **Connected accounts:** the app includes flows for Google Search Console and Analytics, Google Business Profile, Google Ads, Meta Ads, Stripe, and WordPress. Exact read, write, publishing, and verification capabilities differ by integration and server configuration; review the permissions shown before connecting.
- **Agent and MCP:** the agent can use configured hosted or local providers. OpenRecord can expose business-scoped tools over MCP and connect to external MCP servers' read-only tools, subject to their configuration and grants.
- **Research costs:** a business's own connected credential takes precedence where supported. OpenRecord-hosted paid research requires a configured provider, a published price, and prepaid research credit; unavailable or unpriced operations fail rather than silently becoming free.

See [`.env.example`](.env.example) for the configuration and limitations of each provider. Do not assume that public research access permits posting, managing ads, or spending on an account.

## Evidence and safety principles

- **Unknown stays unknown.** Missing, failed, or ambiguous evidence is not treated as false.
- **Keep provenance.** Distinguish public observations, approved facts, suggestions, and human-attested work.
- **Respect permissions and approvals.** Connecting an account does not grant every capability, and consequential actions require the applicable authorization and approval.
- **Verify without inventing causality.** A recorded change is not necessarily deployed, indexed, or responsible for a later outcome.
- **Disclose external processing and cost.** Live providers can receive data and incur charges; use them only with appropriate authorization.

## Run locally

Requirements: Node.js 24 (see [`.node-version`](.node-version)), pnpm, and PostgreSQL 16. For a fresh checkout:

```bash
git clone https://github.com/commonfields/openrecord.git
cd openrecord
pnpm install --frozen-lockfile
docker compose up -d postgres
export DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord"
pnpm db:migrate
pnpm db:seed:demo
```

The demo seed creates `demo@northstar.test` / `password123`. Use these credentials only for local development. Copy [`.env.example`](.env.example) to `.env` and configure a suitable `SESSION_SECRET` and any optional integrations. Load it in each terminal before starting a service (these processes do not load `.env` automatically):

```bash
set -a
. ./.env
set +a
```

Start the services in separate terminals:

```bash
# API: http://localhost:3001
DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord" pnpm --filter @openrecord/api dev

# Worker: discovery, checks, and other background jobs
DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord" pnpm --filter @openrecord/worker dev

# Web: http://localhost:3000
pnpm --filter @openrecord/web dev
```

The hosted agent is separate from measurement providers and is opt-in: set `AGENT_EXTERNAL_PROCESSING_ENABLED`, the appropriate model and credentials only after authorizing external processing. Live answer checks also require their configured providers. For an offline local record walkthrough, `RECORD_PROVIDER=mock RECORD_ALLOW_FIXTURE=1` enables explicitly synthetic answers; it is not live verification.

### Local validation

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Some integration tests require PostgreSQL or other services. See [CONTRIBUTING.md](CONTRIBUTING.md) and the relevant package scripts for details.

## Repository

This is a pnpm workspace: `apps/web` is the web app, `apps/api` the Effect-based API, `apps/worker` the background worker, and `packages/` holds shared contracts, domain logic, integrations, and database code. The Rust CLI under [`src/`](src) is a separate legacy product with its own runtime, configuration, and release process; it is not a backend for the web agent.

## Documentation

- [Agency agent architecture](docs/architecture/agency-agent-v1.md)
- [Market research architecture](docs/architecture/market-research-v1.md)
- [Record integrity architecture](docs/architecture/record-integrity-v1.md)
- [Hosted observation capabilities](docs/engineering/hosted-observation-capabilities-v1.md)
- [Evidence protocol](docs/protocol/README.md)
- [Product roadmap](docs/product/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## License

OpenRecord is available under the [MIT License](LICENSE).
