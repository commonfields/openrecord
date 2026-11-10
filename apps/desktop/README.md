# OpenRecord for macOS

The web workspace as a native Rust app, drawn with
[Rune](https://github.com/anomalyco/rune) (pinned to a `dev` rev in
`Cargo.toml`). It talks to the same API as `apps/web` and copies its design
tokens from `apps/web/app/globals.css`.

It is a standalone Cargo package. The repository root is the frozen legacy
CLI's workspace, and this app does not join it.

## Run

```sh
scripts/dev-up.sh                      # API on :3001
cd apps/desktop
cargo run                              # OPENRECORD_API_URL overrides the API address
```

The session cookie is kept in `~/Library/Application Support/OpenRecord/session`
(mode 600), so a relaunch stays signed in. Sign out from the account menu to
remove it.

## What it covers

- Sign in, with the demo-account shortcut.
- The shell: business switcher, the Agent and Workspace tabs, breadcrumbs, a
  sidebar that collapses to a rail (⌘B), and the account menu.
- Agent: chat history across businesses, transcripts with Markdown replies,
  and sending a message, which follows the run until it settles.
- Workspace: Inbox (decisions waiting), Overview counts, Campaigns, AI answers
  and Channels.

Approving decisions, the results charts, settings and business setup stay on
the web for now. "Open in the browser" in the account menu goes there.

Shortcuts: ⌘N new chat, ⌘R refresh, ⌘1 Agent, ⌘2 Workspace, ⌘B sidebar.

## Check it headlessly

Every screen has a scene built from fixture data, with no network:

```sh
cargo build
./target/debug/openrecord-desktop --snap agent.png --scene agent [--theme dark] [--chrome]
# scenes: signin agent agent-empty inbox overview campaigns ai-answers channels collapsed business-menu
```

`--chrome` draws the traffic lights and reports any element under them.

## Tests

```sh
cargo test                                                    # unit tests
OPENRECORD_NO_SESSION=1 cargo test -- --ignored live_api      # against a running dev API
```
