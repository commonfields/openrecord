# OpenRecord

[![CI](https://github.com/commonfields/openrecord/actions/workflows/ci.yml/badge.svg)](https://github.com/commonfields/openrecord/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/commonfields/openrecord)](LICENSE)

OpenRecord helps you work on a business's marketing with an agent. Give it a website and a goal, connect the accounts you want it to use, and ask it to investigate or suggest what to do next.

It's built for people working on their own business or on behalf of clients. The agent can help research a business, review how it appears in search and AI answers, and prepare changes. You decide whether to approve a proposed action.

## How it works

1. Add a business and tell the agent what you want to achieve.
2. Connect any accounts you want to use, such as Google, Meta, Stripe, or WordPress. What you can connect depends on how your OpenRecord installation is configured.
3. Ask the agent to look into a question or prepare work. It can use the information and tools available to that business.
4. Review proposals in the inbox. For example, a WordPress change needs your approval before OpenRecord publishes it.
5. Check the results and the evidence behind them. What you see depends on the checks you've run and the data you've connected or imported.

The agent can only work with the tools and permissions it has. A connected account doesn't mean every action is supported, and a proposal doesn't mean the work is already done.

## What's in the app

- **Agent** is where you ask questions and work through ideas.
- **Inbox** holds supported proposals and decisions that need your attention.
- **Overview** shows available results, including AI answer checks, search and advertising data, and revenue when the relevant data is available.
- **Channels** is where you connect and manage accounts. Some services use a sign-in flow. Others currently need an API key or application password.
- **Clients and businesses** help you switch between the people and businesses you work with. Each business has its own data and context.

There are also detailed pages for facts, source checks, AI discovery, and client reports. A report shows the evidence available to it; it doesn't automatically cover every tool the agent can use.

## A note about results

OpenRecord keeps observations, human decisions, and recorded work separate. A missing result is not the same as a bad result. If a number comes from a small sample, a provider estimate, or test data, that context matters.

Seeing an AI answer or a metric change after some work also doesn't prove the work caused the change.

## Run it locally

You'll need Node.js 24, pnpm, and PostgreSQL 16. For Docker setup, you'll also need a running Docker daemon.

```bash
git clone https://github.com/commonfields/openrecord.git
cd openrecord
pnpm install --frozen-lockfile
```

If you already have a local database, check your setup before running Docker Compose or migrations. In particular, follow the database notes in [`AGENTS.md`](AGENTS.md) for the existing OpenRecord development machine.

For a fresh local database, start PostgreSQL and run the migrations:

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord"
pnpm db:migrate
```

To add demo data, run `pnpm db:seed:demo`. The demo login is shown in the app's sign-in screen.

Start the API, worker, and web app in separate terminals. Set `DATABASE_URL` in each terminal:

```bash
# API, port 3001
pnpm --filter @openrecord/api dev

# Worker
pnpm --filter @openrecord/worker dev

# Web app, port 3000
pnpm --filter @openrecord/web dev
```

Open [localhost:3000](http://localhost:3000). Live model calls and account connections need their own configuration. See [`.env.example`](.env.example) for the available settings. Live providers can cost money and send data to external services. Mock data is for testing and is not evidence from a live provider.

The API does not reload itself when server code changes. Restart it after changing API code. The web development server reloads frontend changes.

## Platform direction

The web app is the current implementation priority. Complete and validate its
workflows before starting a new desktop client.

The legacy Tauri desktop app was removed on 2026-11-06. The future native desktop
app will start fresh with **Rust + Rune**, not Tauri or GPUI. Desktop development
has not started; this is a direction, not a shipped capability. It should reuse
the current product APIs and approval boundaries, not the legacy CLI runtime.

## The Rust CLI

This repository also contains an older Rust CLI in [`src/`](src). It is separate from the web app and doesn't share its data or authentication. The CLI has different features and scoring rules, so use the web app instructions above if you want to try the current product.

You can install the last published release with [`scripts/install.sh`](scripts/install.sh) on macOS or Linux, or [`scripts/install.ps1`](scripts/install.ps1) on Windows.

To build the CLI from source:

```bash
cargo build --release --locked
./target/release/openrecord quickstart
```

## More information

- [Development and contributing](CONTRIBUTING.md)
- [Agency record guide](docs/product/agency-record-v1-runbook.md)
- [Evidence protocol](docs/protocol/README.md)
- [Product roadmap](docs/product/roadmap.md)

OpenRecord is available under the [MIT License](LICENSE).
