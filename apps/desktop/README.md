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

## Install as an app

```sh
scripts/bundle.sh            # dist/OpenRecord.app and dist/OpenRecord-<version>.dmg
scripts/bundle.sh --debug    # same, from the dev build (much faster to compile)
cp -R dist/OpenRecord.app /Applications/
```

A bundle built on this Mac is ad-hoc signed and opens normally here. A copy
downloaded onto another Mac needs a Developer ID signature and notarization to
open without a warning: set `MACOS_SIGN_IDENTITY` (and `APPLE_ID`,
`APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` to notarize). The `Desktop` workflow
builds an Intel + Apple Silicon `.dmg` on GitHub; a `desktop-v*` tag attaches it
to a release. The app opened from Finder talks to `http://localhost:3001`.

## What it covers

- Sign in, with the demo-account shortcut.
- The shell: business switcher, the Agent and Workspace tabs, breadcrumbs, a
  sidebar that collapses to a rail (⌘B), and the account menu.
- Agent: chat history across businesses, transcripts with Markdown replies in
  Rune's agent timeline ("Thought for 4s", "Used 3 tools", each folding open,
  a "Working" line while a turn runs, helper tasks as chips), charts the agent
  writes in ```chart blocks (bar, line, donut and stat tiles, each plot with a
  table view), and a compact model picker with search.
- The composer: a "/" menu built on Rune's `PopupList` with OpenRecord's
  commands and the playbooks (built-in SEO, AEO and GEO ones and the account's
  own), driven by the arrows, Tab, Return and Escape; a "+" menu to save the
  draft as a playbook, share the chat by read-only link, attach files and
  manage providers; automatic follow-ups by the model picker; and "Start a new
  chat" (⌘N) for a business, a client or a general chat.
- Generated views: the app sends `surfaces: ["ui"]`, so the agent may answer
  with a ```ui block, a flat list of components from a fixed catalog (cards,
  metrics, lists, tables, progress, badges, charts, and "ask" or "open"
  buttons). `src/surface.rs` validates the whole block (budgets, depth, ids,
  reachability, https-only links) before it is drawn inside a "Generated view"
  frame; a refused block shows as code. Needs an API with the `surfaces` field.
  Mermaid diagrams (flowcharts, sequence and state diagrams) draw natively
  through Rune's renderer.
- Also as on the web: the work pane under a chat (proposals waiting for a
  decision, accepted drafts with their text), helper sessions opened beside
  the conversation, commands from plain phrases ("what's next?"), files
  dropped on the composer, and the microphone for macOS dictation. The agent's
  skills are chosen by the server for each turn, so the desktop gets them as
  the web does.
- Workspace: Inbox (approve or decline every kind of decision), the Overview
  with all seven sections and their charts, Campaigns, AI answers (open a claim
  to see the answer, its sources and linked facts, record a verdict, and log
  actions) and Channels.
- Settings, with all seven sections.

Connecting accounts, business setup and the evidence pages stay on the web for
now. "Open in the browser" in the account menu goes there.

Shortcuts: ⌘N new chat, ⌘R refresh, ⌘1 Agent, ⌘2 Workspace, ⌘B sidebar.

## Check it headlessly

Every screen has a scene built from fixture data, with no network:

```sh
cargo build
./target/debug/openrecord-desktop --snap agent.png --scene agent [--theme dark] [--chrome]
# scenes: signin agent agent-empty agent-helper agent-work agent-diagram agent-ui agent-ui-invalid new-chat agent-commands agent-actions agent-save-playbook agent-share agent-followups agent-chart agent-working agent-models-many inbox inbox-wordpress inbox-check inbox-decline overview overview-answers overview-performance overview-revenue overview-funnel overview-events campaigns ai-answers ai-answer ai-answer-review channels collapsed business-menu
```

`--chrome` draws the traffic lights and reports any element under them.

## Tests

```sh
cargo test                                                    # unit tests
OPENRECORD_NO_SESSION=1 cargo test -- --ignored live_api      # against a running dev API
```
