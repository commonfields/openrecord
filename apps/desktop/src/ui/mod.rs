//! The window's view: sign in, or the workspace shell around the page on screen.

mod account_pages;
mod agent;
mod artifacts;
mod answer;
mod campaigns;
mod campaign_brief;
mod channels;
mod channel_setup;
mod charts;
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
pub use shell::{Resize, TITLEBAR, TRAFFIC_LIGHT_INSET};
mod settings;
mod series;
pub mod side;
mod signin;
mod sources;
mod surface;
mod visual;
pub mod widgets;

pub(crate) use shell::web_url;

use rune::{Cursor, Cx, El, ScrollSpec, Transition, col, el, row};
use rune_kit::{Kit, PaletteSeed};

use crate::state::{App, Screen, View};
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::label;

/// The kit's components (text fields, Markdown) on the app's palette.
pub(crate) fn kit(t: &Theme) -> Kit {
    let mut k = Kit::from_palette(PaletteSeed { bg: t.control, fg: t.foreground, accent: t.primary_ink });
    k.c.border_focus = t.ring;
    k
}

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    if !s.artifact_visible() { crate::native_preview::clear(); }
    if s.preview_visible() {
        if let (Some(rect), Some(a)) = (s.preview_rect, s.front_artifact().and_then(|p| p.loaded.ready())) { crate::native_preview::show(&a.preview_html, rect, !s.prefs.reduce_motion); }
    } else { crate::native_preview::hide(); }
    // The browser tab's page sits over its slot only while nothing is drawn over it.
    if s.browser_visible() {
        if let Some(rect) = s.side.browser.rect { crate::native_preview::browser_show(None, rect); }
        crate::native_preview::browser_zoom(if s.side.browser.zoom > 0.0 { s.side.browser.zoom } else { 1.0 });
        // While a menu or dialog is open over it, clicks are the app's.
        crate::native_preview::browser_pass_through(s.native_view_clear());
    } else { crate::native_preview::browser_hide(); }
    let z = s.zoom();
    // Traffic lights: 16pt from the left and top in interface units (symmetric inset).
    let light = (shell::TRAFFIC_LIGHT_INSET * z).round();
    cx.set_titlebar(rune::Titlebar::new((shell::TITLEBAR * z).round()).traffic_lights(light, light));
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
        let before = layers.len();
        layers.extend(notices::layer(s, &t));
        let notice_count = layers.len() - before;
        find::layers(s, &t, &mut layers);
        if let Some(a) = &s.add_business {
            account_pages::add_business_dialog(s, &t, &k, a, &mut layers);
        }
        if let Some(n) = &s.new_chat {
            agent::new_chat_dialog(s, &t, &k, n, &mut layers);
        }
        // An open answer is a popup over the AI answers list.
        if let (Some(a), View::Workspace, crate::state::Page::AiAnswers) = (&s.answer, s.view, s.page) {
            layers.extend(answer::dialog(s, &t, &k, a));
        }
        if let Some(page) = s.settings {
            layers.extend(settings::view(s, &t, &k, page));
        }
        // Any menu or dialog softens what is behind it with a slight blur.
        // Notices are not menus, and the "/" menu leaves its composer sharp.
        let floating = layers.len() - notice_count - usize::from(s.chat_shown() && s.settings.is_none() && agent::command_menu_open(s));
        if floating > 0 {
            layers.insert(0, el().key("menu-backdrop").role("none").a11y_hidden().absolute(0.0, 0.0).w_full().h_full()
                .backdrop_blur(MENU_BLUR).token_motion(k.motion.overlay));
        }
    }
    // Every hover eases in and out over 150 milliseconds on the web's curve
    // (Tailwind's default `transition`), instead of landing at once.
    let ease = rune::Curve::Tween { duration: 0.15, easing: rune::Easing::cubic(0.4, 0.0, 0.2, 1.0) };
    // The window's own colour is the sidebar's, so where the app leaves its
    // view clear (over a page in the browser, drawn behind it) the frame
    // around the page still reads as the app.
    crate::native_preview::window_background(t.sidebar);
    crate::native_preview::browser_backdrop(t.background);
    let screen = if s.screen == Screen::Workspace && s.browser_page_shown() { screen } else { screen.fill(t.sidebar) };
    let root = rune_kit::root(screen.hover_motion_within(ease, ease), layers);
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

/// How much an open menu or dialog blurs the window behind it, in points.
const MENU_BLUR: f32 = 4.0;

/// The chat narrowing for a card beside it, and the card arriving: unhurried and with no bounce.
const SPLIT: rune::Spring = rune::Spring::new(0.38, 0.0);

fn workspace(s: &App, t: &Theme, k: &Kit, titlebar_inset: f32) -> El {
    // Collapsed, the sidebar is out of the layout and the traffic lights sit
    // over the header: the breadcrumbs start past them and the two buttons
    // beside them (Find and the sidebar's), with the same 12-point gap the
    // buttons keep from the lights. The header itself starts 8 points in (the
    // panel's inset) and pads 20 points of its own.
    let leading = if s.sidebar_open { 0.0 } else { (shell::collapsed_slot_end(titlebar_inset) + 12.0 - 8.0 - 20.0).max(0.0) };
    let (content, trailing): (El, Option<El>) = match s.view {
        View::Agent if s.active.is_some() || s.general => (agent::view(s, t, k), None),
        View::Agent => (agent_boot(s, &t), None),
        // The inbox fills the panel; its list and reading pane scroll on their own.
        View::Workspace if s.page == crate::state::Page::Inbox => (col().key("page-inbox").w_full().grow(1.0).min_h(0.0).child(pages::inbox(s, t)), None),
        // Analytics too: its tabs stay put and its sheet fills the panel, inset as the panel is in the window.
        View::Workspace if s.page == crate::state::Page::Overview => (
            col().key("page-analytics").w_full().grow(1.0).min_h(0.0).px(8.0).pb(8.0).child(overview::view(s, t, false)),
            None,
        ),
        View::Workspace if s.page == crate::state::Page::AiAnswers => (
            col().key("answers-page").w_full().grow(1.0).min_h(0.0)
                .px(40.0).pt(32.0).pb(16.0).child(pages::view(s, t)),
            None,
        ),
        View::Workspace => {
            let page = col()
                .key(format!("page-scroll-{}", s.channel_setup.as_ref().map(|p| p.generation).unwrap_or(0)))
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                // Full width inside the content inset, as the web's workspace pages are.
                .child(col().w_full().px(40.0).pt(32.0).pb(40.0).child(pages::view(s, t)))
                .scroll(ScrollSpec { stick_bottom: false });
            (page, None)
        }
    };
    // The right panel's button sits at the header's right end while it is folded;
    // open, the panel carries its own.
    let trailing = if s.side_shown() { trailing } else { Some(row().gap(4.0).center_y().children(trailing).child(side::toggle(t, false))) };
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
    // The right panel: the artifact or helper and a browser, as tabs. Its share
    // is dragged from its left edge as the sidebar's width is; widened, it
    // takes the whole split and the page steps aside.
    let wide = s.side_shown() && s.side.wide;
    // Widened with the sidebar folded, the panel reaches the window's left edge:
    // its tabs start past the traffic lights and the sidebar's buttons, 12
    // points after them as the header's breadcrumbs do (the card sits 8 in).
    let strip_lead = if wide && !s.sidebar_open { shell::collapsed_slot_end(titlebar_inset) + 12.0 - 8.0 } else { 10.0 };
    let side_card = s.side_shown().then(|| side::view(s, t, k, strip_lead));
    let panel = col()
        .key("panel-column")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .pt(8.0)
        .pb(8.0)
        .pr(if side_card.is_some() { 0.0 } else { 8.0 })
        .pl(if s.sidebar_open || wide { 0.0 } else { 8.0 })
        .opacity(if wide { 0.0 } else { 1.0 })
        .child(panel);
    // The rows around the panel are always there, so opening a card beside it
    // or the agent pane only narrows it. Built only when needed, they would
    // move the panel to a new parent, and it would crossfade with a copy of itself.
    let mut split = row()
        .key("side-split")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        // Layout units already: the zoom scales the whole drawn tree, not its layout.
        .on_layout(|s: &mut App, r: [f32; 4]| s.split_w = r[2])
        .child(panel.w(0.0).motion(SPLIT));
    if let Some(card) = side_card {
        let w = if s.split_w <= 0.0 {
            0.0
        } else if wide {
            s.split_w
        } else {
            (s.split_w * s.prefs.helper() / 100.0).round()
        };
        split = split.child(
            // It slides in from the right edge and fades up while the chat
            // narrows beside it; closing plays it backwards.
            col()
                .key("side-panel-column")
                .w(w)
                .grow(if w > 0.0 { 0.0 } else { 1.0 })
                // Held at its share: without it the panel's content outweighs it.
                .min_w(w)
                .transition(Transition::offset(96.0, 0.0).combined(Transition::opacity()))
                .motion(SPLIT)
                .h_full()
                .pt(8.0)
                .pb(8.0)
                // 4 points from the page beside it: the two read as one surface, split.
                .pl(if wide && !s.sidebar_open { 8.0 } else if wide { 0.0 } else { 4.0 })
                .pr(8.0)
                .child(card)
                .children((!wide).then(|| agent::side_edge("side"))),
        );
    }
    let mut ws = row().key("workspace").w_full().h_full();
    if s.sidebar_open {
        ws = ws.child(shell::sidebar(s, t));
    }
    ws = ws.child(split);
    // Over the page panel, so it draws on top of the header beside the traffic lights.
    if !s.sidebar_open {
        ws = ws.child(shell::collapsed_toggle(s, t, titlebar_inset));
    }
    ws.children(shell::sidebar_overlay(s, t))
}

/// Brief placeholder while the first business is selected after sign-in — no setup CTA here (use sidebar).
fn agent_boot(s: &App, t: &Theme) -> El {
    let hint = if s.businesses.is_empty() {
        "Loading your account…"
    } else {
        "Opening Home…"
    };
    col()
        .key("agent-boot")
        .w_full()
        .h_full()
        .center()
        .child(label(hint, type_::BASE_MEDIUM, t.muted_foreground))
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
