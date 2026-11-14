//! OpenRecord for macOS: the web workspace as a native app, drawn with Rune.
//!
//! It talks to the same API the web app does (`OPENRECORD_API_URL`, default
//! `http://localhost:3001`) and keeps its session between launches.
//!
//! `cargo run` opens the window. Headless, with fixture data and no network:
//! `cargo run -- --snap agent.png --scene agent [--theme dark]`.

mod account;
mod artifacts;
mod native_preview;
mod api;
mod brand_marks;
mod brands;
mod channel_marks;
mod channel_status;
mod channel_setup;
mod chat;
mod decisions;
mod dictation;
mod drafts;
mod fixtures;
mod followups;
mod format;
mod icons;
mod insights;
mod net;
mod navigation;
mod prefs;
mod settings;
mod setup;
mod state;
mod surface;
mod theme;
mod ui;
mod update;
mod visual;

use rune::{AppSpec, Chrome, KeyEvent, Tx, Waker};

use crate::state::App;

fn setup(s: &mut App, waker: Waker) {
    s.net.set_waker(waker);
    s.start();
}

fn poll(s: &mut App, _clock: f64, tx: &mut Tx) -> bool {
    s.poll(tx)
}

fn on_key(s: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if s.screen != state::Screen::Workspace {
        return false;
    }
    if ev.is_command(',') {
        s.open_settings(state::SettingsPage::General);
        return true;
    }
    // "Find…": Escape closes it, the arrows move through its results.
    if s.find.is_some() {
        match ev.key {
            rune::Key::Escape => s.find = None,
            rune::Key::Up => ui::find::step(s, -1),
            rune::Key::Down => ui::find::step(s, 1),
            _ if ev.is_command('k') => s.find = None,
            _ => return false,
        }
        return true;
    }
    // ↑ and ↓ move through the inbox.
    if s.settings.is_none() && s.view == state::View::Workspace && s.page == state::Page::Inbox && matches!(ev.key, rune::Key::Up | rune::Key::Down) && !ev.mods.cmd {
        s.step_decision(if ev.key == rune::Key::Up { -1 } else { 1 });
        return true;
    }
    // F (when no text field has the key) or ⌘K opens it, as on the web.
    if s.settings.is_none() && (ev.is_command('k') || (matches!(&ev.key, rune::Key::Text(c) if c == "f" || c == "F") && !ev.mods.cmd && !ev.mods.ctrl && !ev.mods.alt)) {
        s.toggle_find(tx);
        return true;
    }
    if s.artifact_visible() && ev.key == rune::Key::Escape {
        s.artifact = None;
        return true;
    }
    // Escape closes a helper opened beside the conversation, as on the web.
    if s.settings.is_none() && s.helper.is_some() && ev.key == rune::Key::Escape {
        s.helper = None;
        return true;
    }
    // Then the agent pane beside a page, unless the composer's "/" menu takes the key.
    if s.settings.is_none() && s.pane_shown() && ev.key == rune::Key::Escape && s.menu.is_none() && s.menu_entries().is_empty() {
        s.close_pane();
        return true;
    }
    if s.settings.is_some() {
        if ev.key == rune::Key::Escape {
            s.settings = None;
            return true;
        }
        return false;
    }
    // With "Send with Enter" off, ⌘Return sends.
    if ev.key == rune::Key::Enter && ev.mods.cmd && !s.prefs.enter_to_send && s.chat_shown() {
        s.send_message(tx);
        return true;
    }
    // ⌘+ (or ⌘=), ⌘− and ⌘0 zoom the interface, as a browser does.
    if ev.is_command('=') || ev.is_command('+') {
        s.zoom_by(1);
        return true;
    }
    if ev.is_command('-') {
        s.zoom_by(-1);
        return true;
    }
    if ev.is_command('0') {
        s.zoom_by(0);
        return true;
    }
    if ev.is_command('b') {
        s.toggle_sidebar();
        return true;
    }
    if ev.is_command('n') {
        s.open_new_chat(tx);
        return true;
    }
    if ev.is_command('r') {
        s.refresh();
        return true;
    }
    if ev.is_command('1') {
        s.show_view(state::View::Agent);
        return true;
    }
    if ev.is_command('2') {
        s.show_view(state::View::Workspace);
        return true;
    }
    false
}

const SCENES: &[(&str, fn(&mut App))] = &[
    ("signin", fixtures::signin),
    ("agent", fixtures::agent),
    ("agent-artifact", fixtures::agent_artifact),
    ("channels-wordpress", fixtures::channels_wordpress),
    ("channels-google", fixtures::channels_google),
    ("agent-empty", fixtures::agent_empty),
    ("notices-open", fixtures::notices_open),
    ("agent-log", fixtures::agent_open_log),
    ("agent-chart", fixtures::agent_chart),
    ("agent-chart-table", fixtures::agent_chart_table),
    ("agent-chart-top", fixtures::agent_chart_top),
    ("agent-working", fixtures::agent_working),
    ("agent-models", fixtures::agent_models),
    ("agent-models-many", fixtures::agent_models_many),
    ("agent-commands", fixtures::agent_commands),
    ("agent-actions", fixtures::agent_actions),
    ("agent-save-playbook", fixtures::agent_save_playbook),
    ("agent-share", fixtures::agent_share),
    ("agent-followups", fixtures::agent_followups),
    ("agent-reasoning", fixtures::agent_reasoning),
    ("agent-failed", fixtures::agent_failed),
    ("new-chat", fixtures::new_chat),
    ("agent-ui", fixtures::agent_ui),
    ("agent-series", fixtures::agent_series),
    ("agent-helper", fixtures::agent_helper),
    ("agent-work", fixtures::agent_work),
    ("agent-diagram", fixtures::agent_diagram),
    ("agent-ui-invalid", fixtures::agent_ui_invalid),
    ("agent-compose", fixtures::agent_compose),
    ("agent-archived", fixtures::agent_archived),
    ("overview-agent", fixtures::overview_agent),
    ("settings-general", fixtures::settings_general),
    ("settings-agent", fixtures::settings_agent),
    ("settings-account", fixtures::settings_account),
    ("inbox", fixtures::inbox),
    ("inbox-wordpress", fixtures::inbox_wordpress),
    ("inbox-check", fixtures::inbox_check),
    ("inbox-decline", fixtures::inbox_decline),
    ("overview", fixtures::overview),
    ("overview-answers", fixtures::overview_answers),
    ("overview-answers-split", fixtures::overview_answers_split),
    ("overview-answers-hover", fixtures::overview_answers_hover),
    ("overview-answers-share", fixtures::overview_answers_share),
    ("overview-performance", fixtures::overview_performance),
    ("overview-revenue", fixtures::overview_revenue),
    ("overview-funnel", fixtures::overview_funnel),
    ("overview-realtime", fixtures::overview_realtime),
    ("overview-events", fixtures::overview_events),
    ("campaigns", fixtures::campaigns),
    ("campaign", fixtures::campaign_open),
    ("ai-answers", fixtures::ai_answers),
    ("ai-answer", fixtures::ai_answer),
    ("ai-answer-review", fixtures::ai_answer_review),
    ("channels", fixtures::channels),
    ("collapsed", fixtures::collapsed),
    ("collapsed-peek", fixtures::collapsed_peek),
    ("business-menu", fixtures::business_menu),
    ("agent-find", fixtures::agent_find),
    ("account-update", fixtures::account_update),
    ("account-menu", fixtures::account_menu),
    ("usage", fixtures::usage),
    ("businesses", fixtures::businesses),
    ("clients", fixtures::clients),
    ("add-business", fixtures::add_business),
];

fn main() {
    // Deterministic renderer probe, before creating an application or reading a session.
    if std::env::args().nth(1).as_deref() == Some("--preview-test-document") {
        println!("{}", native_preview::document("<style>html,body{margin:0;height:100%;background:blue}</style><script>document.body.style.background='red'</script>"));
        return;
    }
    rune::prewarm_gpu();
    let spec = AppSpec {
        min_size: Some((820.0, 560.0)),
        scenes: SCENES,
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(on_key),
        ..AppSpec::new("OpenRecord", (1280.0, 800.0), App::new, ui::view)
    };
    rune::App::new(spec)
        .chrome(Chrome { full_size_content: true, traffic_lights: Some((16.0, 22.0)), drag_regions: true })
        .titlebar(rune::Titlebar::new(50.0).traffic_lights(16.0, 22.0))
        .standard_menus()
        // Fills the screen at launch, so the chat and the notifications have room side by side.
        .maximized(true)
        .run();
}
