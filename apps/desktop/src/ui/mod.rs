//! The window's view: sign in, or the workspace shell around the page on screen.

mod account_pages;
mod agent;
pub use agent::ROLL_EVERY;
mod answer;
mod campaigns;
mod channels;
mod charts;
mod cube3d;
mod discovery;
pub mod find;
pub mod issues;
pub mod world;
mod world_land;
mod kit;
pub mod notices;
mod overview;
pub use overview::number as overview_number;
mod pages;
mod shell;
pub use shell::Resize;
mod settings;
mod series;
mod signin;
mod sources;
mod surface;
mod visual;
pub mod widgets;

pub(crate) use shell::web_url;

use rune::{Cursor, Cx, El, ScrollSpec, col, row};
use rune_kit::{Kit, PaletteSeed};

use crate::state::{App, Screen, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::label;

/// The kit's components (text fields, Markdown) on the app's palette.
fn kit(t: &Theme) -> Kit {
    let mut k = Kit::from_palette(PaletteSeed { bg: t.control, fg: t.foreground, accent: t.primary_ink });
    k.c.border_focus = t.ring;
    k
}

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let z = s.zoom();
    // The traffic lights follow the zoom so they stay on the header's line,
    // 32 points down in the interface's own units.
    cx.set_titlebar(rune::Titlebar::new((56.0 * z).round()).traffic_lights(16.0, (32.0 * z - 7.0).round()));
    let t = Theme::get(s.prefs.dark(cx.system_dark()));
    if s.prefs.reduce_motion {
        cx.reduced_motion(true);
    }
    let k = kit(&t);
    let screen = match s.screen {
        Screen::Restoring => signin::restoring(&t),
        Screen::SignIn => signin::view(s, &t, &k),
        Screen::Workspace => workspace(s, &t, &k, cx.titlebar_inset() / z),
    };
    let mut layers = Vec::new();
    if s.screen == Screen::Workspace {
        if let Some(m) = shell::menus(s, &t) {
            layers.push(m);
        }
        shell::account_menu(s, &t, &k, &mut layers);
        if s.chat_shown() && s.settings.is_none() {
            agent::layers(s, &t, &k, &mut layers);
        }
        layers.extend(notices::layer(s, &t));
        find::layers(s, &t, &mut layers);
        if let Some(a) = &s.add_business {
            account_pages::add_business_dialog(s, &t, &k, a, &mut layers);
        }
        if let Some(n) = &s.new_chat {
            agent::new_chat_dialog(s, &t, &k, n, &mut layers);
        }
        if let Some(page) = s.settings {
            layers.extend(settings::view(s, &t, &k, page));
        }
    }
    // Every hover eases in and out over 150 milliseconds on the web's curve
    // (Tailwind's default `transition`), instead of landing at once.
    let ease = rune::Curve::Tween { duration: 0.15, easing: rune::Easing::cubic(0.4, 0.0, 0.2, 1.0) };
    let root = rune_kit::root(screen.fill(t.sidebar).hover_motion_within(ease, ease), layers);
    zoomed(s, root, z)
}

/// The whole interface at the zoom (⌘+ and ⌘−): laid out at the window's size
/// divided by it, then drawn that many times larger about the window's centre,
/// so it fills the window exactly. Menus and dialogs inside it zoom with it.
fn zoomed(s: &App, root: El, z: f32) -> El {
    let (w, h) = if s.window.0 > 0.0 { s.window } else { (1280.0, 800.0) };
    let (iw, ih) = (w / z, h / z);
    col()
        .key("zoom")
        .w_full()
        .h_full()
        .on_layout(|s: &mut App, r: [f32; 4]| s.window = (r[2], r[3]))
        .child(root.w(iw).h(ih).absolute((w - iw) / 2.0, (h - ih) / 2.0).scale(z))
}

fn workspace(s: &App, t: &Theme, k: &Kit, titlebar_inset: f32) -> El {
    // With the sidebar a narrow rail, the traffic lights sit over the header,
    // so it starts past them.
    // Collapsed, the sidebar is out of the layout and the traffic lights sit over the header.
    // Past the traffic lights and the sidebar button beside them.
    let leading = if s.sidebar_open { 0.0 } else { titlebar_inset.max(16.0) + 6.0 + 28.0 + 4.0 - 20.0 };
    let (content, trailing) = match s.view {
        View::Agent if s.active.is_some() || s.general => (agent::view(s, t, k), None),
        View::Agent => (choose_business(t), None),
        // The inbox fills the panel; its list and reading pane scroll on their own.
        View::Workspace if s.page == crate::state::Page::Inbox => (col().key("page-inbox").w_full().grow(1.0).min_h(0.0).child(pages::inbox(s, t)), None),
        View::Workspace => {
            let page = col()
                .key("page-scroll")
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                // Full width inside the content inset, as the web's workspace pages are.
                .child(col().w_full().px(40.0).pt(32.0).pb(40.0).child(pages::view(s, t)))
                .scroll(ScrollSpec { stick_bottom: false });
            (page, None)
        }
    };
    let panel = shadows(
        col()
            .key("panel")
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .radius(10.0)
            .fill(t.background)
            .clip_rounded(10.0)
            .child(shell::header(s, t, leading, trailing))
            .children(s.notice.as_deref().map(|n| notice(t, n)))
            .child(col().w_full().grow(1.0).min_h(0.0).child(content)),
        &t.panel_shadow,
    );
    let panel = col().key("panel-column").grow(1.0).min_w(0.0).h_full().pt(8.0).pb(8.0).pr(8.0).pl(if s.sidebar_open { 0.0 } else { 8.0 }).child(panel);
    // The agent beside a workspace page: its own card left of the page, where
    // the sidebar was, as the web's `AgentPane` sits.
    let main = if s.pane_shown() {
        row()
            .key("pane-split")
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .on_layout(|s: &mut App, r: [f32; 4]| s.pane_row_w = r[2] / s.zoom())
            .child(agent::pane(s, t, k))
            .child(panel)
    } else {
        panel
    };
    let mut ws = row().key("workspace").w_full().h_full();
    if s.sidebar_open {
        ws = ws.child(shell::sidebar(s, t));
    }
    ws = ws.child(main);
    // Over the page panel, so it draws on top of the header beside the traffic lights.
    if !s.sidebar_open {
        ws = ws.child(shell::collapsed_toggle(t, titlebar_inset));
    }
    ws.children(shell::sidebar_overlay(s, t))
}

fn choose_business(t: &Theme) -> El {
    // The whole setup is one line: the website. The agent reads it and asks for the goal in chat.
    col()
        .key("choose-business")
        .w_full()
        .h_full()
        .center()
        .gap(8.0)
        .child(label("Start with your website", rune::TextStyle::new(24.0, 600.0).lh(32.0), t.foreground).role("heading"))
        .child(label("Give OpenRecord a website and the agent reads it, learns the business and asks what you want more of.", type_::SM, t.muted_foreground).wrap().max_w(460.0))
        .child(rune::el().h(6.0))
        .child(widgets::button(t, "start-add-business", "Add a website", widgets::Variant::Primary).on_press(|s: &mut App| s.open_add_business(None)))
}

/// A bar under the header for something the shell has to say: the web's
/// `Alert`, a bordered card with its text and a way to dismiss it.
fn notice(t: &Theme, text_: &str) -> El {
    let body = row()
        .w_full()
        .gap(10.0)
        .center_y()
        .live_region(rune::LiveRegion::Polite)
        .child(label(text_.to_string(), type_::XS, t.foreground).wrap().grow(1.0).min_w(0.0))
        .child(
            label("Dismiss", type_::XS_MEDIUM, t.muted_foreground)
                .key("notice-dismiss")
                .role("button")
                .cursor(Cursor::Pointer)
                .on_press(|s: &mut App| s.notice = None),
        );
    col().w_full().px(20.0).pb(8.0).child(crate::ui::widgets::alert(t, "notice", None, body))
}
