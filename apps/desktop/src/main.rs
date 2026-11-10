//! OpenRecord for macOS: the web workspace as a native app, drawn with Rune.
//!
//! It talks to the same API the web app does (`OPENRECORD_API_URL`, default
//! `http://localhost:3001`) and keeps its session between launches.
//!
//! `cargo run` opens the window. Headless, with fixture data and no network:
//! `cargo run -- --snap agent.png --scene agent [--theme dark]`.

mod api;
mod brand_marks;
mod brands;
mod decisions;
mod fixtures;
mod format;
mod icons;
mod insights;
mod net;
mod state;
mod theme;
mod ui;

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
    if ev.is_command('b') {
        s.sidebar_open = !s.sidebar_open;
        return true;
    }
    if ev.is_command('n') {
        s.new_chat();
        tx.focus("composer-input", false);
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
    ("agent-empty", fixtures::agent_empty),
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
    ("overview-events", fixtures::overview_events),
    ("campaigns", fixtures::campaigns),
    ("ai-answers", fixtures::ai_answers),
    ("channels", fixtures::channels),
    ("collapsed", fixtures::collapsed),
    ("business-menu", fixtures::business_menu),
];

fn main() {
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
        .chrome(Chrome { full_size_content: true, traffic_lights: Some((16.0, 13.0)), drag_regions: true })
        .standard_menus()
        .run();
}
