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

The sign-in card shows which server it signs in to, with "Change" to name
another. A server must be HTTPS unless it is on this Mac; the address is kept
in the preferences, and changing it forgets the saved session so its cookie
never reaches another host. `OPENRECORD_API_URL` still wins, for development.

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
to a release. The app opened from Finder talks to the server chosen at sign-in
(`http://localhost:3001` until one is).

## Updates

The account menu checks GitHub for a newer release at launch and offers
"Update to x.y.z". One press downloads that release's `.dmg`, copies the app
over the running `OpenRecord.app` (staged beside it, then swapped), and
restarts into it. A dot on the account avatar shows an update is waiting.

Before anything is replaced, the updater checks that the download is one of
this repository's release assets over HTTPS, that the copied app's signature
is intact (`codesign --verify --deep --strict`), and, when the running app is
signed by a team, that the new one is signed by the same team. A build signed
ad hoc has no team to compare, so only the first two checks hold for it.

To ship one, bump `version` in `Cargo.toml` and push a `desktop-vX.Y.Z` tag
with the same number; the Desktop workflow attaches the `.dmg` the updater
downloads. Drafts and pre-releases are skipped. A copy run with `cargo run`
can check but not install, since it is not inside an `.app`.

## What it covers

- Sign in, with the demo-account shortcut.
- The shell: one sidebar for the whole product (the business switcher, Home,
  Inbox, Analytics, Campaigns, AI answers and Channels, then the chats), which
  collapses (⌘B); breadcrumbs; "Ask the agent" on every business page, which
  opens the agent beside it; and the account menu. There are no Agent and
  Workspace tabs: this is where the app's layout departs from the web's, while
  its surfaces, type and colours stay the web's tokens.
- Home: a business's new chat opens on what is waiting for the person's
  decision (each opens in the Inbox) and four ways to start that send in one
  press. With no business yet, it asks for a website.
- Analytics: the Overview's seven sections as tabs across the top with the
  date range beside them. Summary puts the goal's chart next to "Needs you";
  a source's key numbers sit on one line of compact charts when the window
  has room, so the tables under them are on the first screen.
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
  the conversation, files
  dropped on the composer, and the microphone for macOS dictation. The agent's
  skills are chosen by the server for each turn, so the desktop gets them as
  the web does.
- Pages: Inbox (approve or decline every kind of decision), Analytics
  with all seven sections and their charts, Campaigns, AI answers (open a claim
  to see the answer, its sources and linked facts, record a verdict, and log
  actions) and Channels.
- Settings, with all seven sections.

Connecting accounts, business setup and the evidence pages stay on the web for
now. "Open in the browser" in the account menu goes there.

Shortcuts: ⌘N new chat, ⌘R refresh, ⌘1 the agent, ⌘2 the page last open, ⌘B sidebar.

## Check it headlessly

Every screen has a scene built from fixture data, with no network:

```sh
cargo build
./target/debug/openrecord-desktop --snap agent.png --scene agent [--theme dark] [--chrome]
# scenes: signin agent overview-agent agent-empty agent-helper agent-work agent-diagram agent-ui agent-ui-invalid new-chat agent-commands agent-actions agent-save-playbook agent-share agent-followups agent-chart agent-working agent-models-many inbox inbox-wordpress inbox-check inbox-decline overview overview-answers overview-performance overview-revenue overview-funnel overview-events campaigns ai-answers ai-answer ai-answer-review channels collapsed business-menu
```

`--chrome` draws the traffic lights and reports any element under them.

## Tests

```sh
cargo test                                                    # unit tests
OPENRECORD_NO_SESSION=1 cargo test -- --ignored live_api      # against a running dev API
```
