//! The window's view: sign in, or the workspace shell around the page on screen.

mod account_pages;
mod agent;
mod artifacts;
mod answer;
mod campaign_timeline;
mod campaigns;
mod campaign_brief;
mod channels;
mod channel_setup;
mod charts;
pub use charts::LineCache;
mod discovery;
pub mod find;
pub mod issues;
pub mod world;
mod world_land;
mod kit;
pub mod notices;
mod overview;
pub use overview::number as overview_number;
pub(crate) mod inbox;
mod pages;
mod shell;
pub use shell::{Resize, TITLEBAR, TRAFFIC_LIGHT_INSET};
mod settings;
mod series;
mod words;
pub mod side;
mod signin;
mod sources;
mod surface;
mod visual;
pub mod widgets;

pub(crate) use shell::web_url;

use rune::{Cursor, Cx, El, ScrollSpec, SpringPair, Transition, col, el, row};
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

/// After each drawn frame: the artifact page goes where its slot was drawn,
/// through the panel's springs and its slide in and out, so the page and its
/// tab strip move as one. Once the slot is gone, the page goes too.
///
/// The page's new frame reaches the screen a frame after the app's, so it is
/// placed over both this frame's slot and the next one's (one frame further
/// on the same velocity, never past where the slot rests): wherever the slot
/// is drawn when the page lands, the page covers it and no window shows at its
/// leading edge. What sticks out is under the strip or the chat.
pub fn follow_drawn(rt: &rune::Runtime<App>) {
    thread_local! {
        static LAST: std::cell::Cell<Option<[f32; 4]>> = const { std::cell::Cell::new(None) };
        static COVERED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }
    let s = &rt.state;
    if !s.page_shot_moving() { COVERED.with(|c| c.set(0)); }
    match rt.presented("artifact-html") {
        // While its picture moves in its place the page stays where it was, hidden (`page_shot`).
        Some(_) if s.page_shot_moving() => {
            // The page hides only under a frame that shows its picture: hidden
            // sooner, the window showed through for the frames before.
            // A drawn frame reaches the screen a little after the page's own
            // change does, so it waits a few frames with the picture over it.
            let shown = rt.presented("artifact-shot").is_some_and(|(_, o)| o > 0.99);
            let frames = COVERED.with(|c| { let n = if shown { c.get() + 1 } else { 0 }; c.set(n); n });
            if frames >= 3 { crate::native_preview::conceal(true); }
        }
        Some((r, _)) if r[2] > 1.0 && r[3] > 1.0 && (s.preview_visible() || !s.side_shown()) => {
            let last = LAST.with(|c| c.replace(Some(r)));
            crate::native_preview::place(ahead(r, last, s.preview_rect));
        }
        None if !s.side_shown() => {
            LAST.with(|c| c.set(None));
            crate::native_preview::clear()
        }
        _ => {}
    }
}

/// `r` widened to also cover where it will be a frame later, from its last
/// step, held within the rect it rests at. Edges, not sizes, so a panel that
/// grows leftwards keeps its right edge.
fn ahead(r: [f32; 4], last: Option<[f32; 4]>, rest: Option<[f32; 4]>) -> [f32; 4] {
    let edges = |a: [f32; 4]| [a[0], a[1], a[0] + a[2], a[1] + a[3]];
    let now = edges(r);
    let (Some(last), Some(rest)) = (last.map(edges), rest.map(edges)) else { return r };
    let mut lo = now;
    let mut hi = now;
    for i in 0..4 {
        let next = now[i] + (now[i] - last[i]);
        // Never past the resting edge: the springs here do not overshoot.
        let next = if rest[i] >= now[i] { next.clamp(now[i], rest[i]) } else { next.clamp(rest[i], now[i]) };
        lo[i] = now[i].min(next);
        hi[i] = now[i].max(next);
    }
    // Outermost edges of the two: the left and top from the lower, right and bottom from the higher.
    [lo[0], lo[1], hi[2] - lo[0], hi[3] - lo[1]]
}

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    // The artifact page is loaded here and moved every frame to where its slot
    // is drawn (`follow_drawn`); folding the panel, it rides out with it.
    if s.side_shown() && !s.artifact_visible() { crate::native_preview::clear(); }
    if s.preview_visible() {
        if let (Some(rect), Some(a)) = (s.preview_rect, s.front_artifact().and_then(|p| p.loaded.ready())) {
            crate::native_preview::show(&a.preview_html, rect, false);
        }
        crate::native_preview::preview_pass_through(s.native_view_clear());
    } else if s.side_shown() {
        crate::native_preview::hide();
    }
    // The browser tab's page sits over its slot only while nothing is drawn over it.
    if s.browser_visible() {
        if let Some(rect) = s.side.browser.rect { crate::native_preview::browser_show(None, s.gliding(2, rect)); }
        crate::native_preview::browser_zoom(if s.side.browser.zoom > 0.0 { s.side.browser.zoom } else { 1.0 });
        // While a menu or dialog is open over it, clicks are the app's.
        crate::native_preview::browser_pass_through(s.native_view_clear());
    } else { crate::native_preview::browser_hide(); }
    // Overview beside the chat is heavy Rune UI; native markdown is enough while it is open.
    if s.prefs.words_webview
        && s.words_transcript_webview()
        && s.words_rect.is_some()
        && s.chat_shown()
        && s.settings.is_none()
        && !s.side_shows_overview()
    {
        crate::words_pane::pass_through(s.native_view_clear());
        crate::words_pane::sync(s, s.prefs.dark(cx.system_dark()));
    } else {
        crate::words_pane::hide();
    }
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
        if !s.sidebar_open {
            layers.push(shell::collapsed_sidebar_layer(s, &t, cx.titlebar_inset() / z));
        }
        if let Some(m) = shell::menus(s, &t) {
            layers.push(m);
        }
        if s.chat_shown() && s.settings.is_none() {
            agent::layers(s, &t, &k, &mut layers);
        }
        let before = layers.len();
        let notice_count = layers.len() - before;
        find::layers(s, &t, &mut layers);
        if let Some(a) = &s.add_business {
            account_pages::add_business_dialog(s, &t, &k, a, &mut layers);
        }
        if let Some(n) = &s.new_chat {
            agent::new_chat_dialog(s, &t, &k, n, &mut layers);
        }
        if s.business_picker.is_some() {
            shell::business_picker_dialog(s, &t, &k, &mut layers);
        }
        // An open answer is a popup over the AI answers list.
        if let (Some(a), View::Workspace, crate::state::Page::AiAnswers) = (&s.answer, s.view, s.page) {
            layers.extend(answer::dialog(s, &t, &k, a));
        }
        if let Some(page) = s.settings {
            layers.extend(settings::view(s, &t, &k, page));
        }
        if let Some(note) = &s.notice {
            layers.push(notice_toast(&t, note));
        }
        // Only Find and New chat soften the window behind them; other menus stay sharp.
        let _ = notice_count;
        if s.find.is_some() || s.new_chat.is_some() || s.business_picker.is_some() {
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
    let page_light = if s.browser_page_shown() {
        crate::native_preview::browser_page_light()
    } else if s.artifact_preview_float() {
        crate::native_preview::preview_page_light()
    } else {
        None
    };
    let browser_backdrop = match page_light {
        Some(light) => Theme::get(!light).background,
        None if s.browser_page_shown() && s.browser_artifact().is_some() => Theme::get(false).background,
        None if s.artifact_preview_float() => Theme::get(false).background,
        None => t.background,
    };
    crate::native_preview::browser_backdrop(browser_backdrop);
    let native_page = s.browser_page_shown() || s.artifact_preview_float();
    let screen = if s.screen == Screen::Workspace && native_page { screen } else { screen.fill(t.sidebar) };
    // Swap light/dark instantly, like the web's `theme-switching` (no colour crossfade).
    let screen = screen.key(if t.dark { "ui-theme-dark" } else { "ui-theme-light" }).motion(rune::Spring::NONE);
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
const SPLIT: rune::Spring = crate::state::SIDEBAR_SPRING;

fn workspace(s: &App, t: &Theme, k: &Kit, titlebar_inset: f32) -> El {
    // Collapsed, the sidebar is out of the layout and the traffic lights sit
    // over the header: the breadcrumbs start past them and the two buttons
    // beside them (Find and the sidebar's), with the same 12-point gap the
    // buttons keep from the lights. The header itself starts 8 points in (the
    // panel's inset) and pads 20 points of its own.
    let inset = shell::CANVAS_INSET;
    let leading = if s.sidebar_open { 0.0 } else { (shell::collapsed_slot_end(titlebar_inset) + 12.0 - inset - 20.0).max(0.0) };
    let (content, trailing): (El, Option<El>) = match s.view {
        View::Agent if s.active.is_some() || s.general => (agent::view(s, t, k), None),
        View::Agent => (agent_boot(s, &t), None),
        // The inbox fills the panel; its list and reading pane scroll on their own.
        View::Workspace if s.page == crate::state::Page::Inbox => (col().key("page-inbox").w_full().grow(1.0).min_h(0.0).child(pages::inbox(s, t)), None),
        // Analytics too: its tabs stay put and its sheet fills the panel, inset as the panel is in the window.
        View::Workspace if s.page == crate::state::Page::Overview => (
            col().key("page-analytics").w_full().grow(1.0).min_h(0.0).child(overview::view(s, t, false)),
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
    // Same rim and float as the composer's "/" menu (`command-menu`), but the page fill stays `background`.
    let panel = shadows(
        col()
            .key("panel")
            .grow(1.0)
            .min_w(0.0)
            .h_full()
            .radius(10.0)
            .fill(t.background)
            .border(1.0, t.border)
            .clip_rounded(10.0)
            .child(shell::header(s, t, leading, trailing))
            .child(col().w_full().grow(1.0).min_h(0.0).child(content)),
        &t.control_shadow,
    );
    // The right panel: the artifact or helper and a browser, as tabs. Its share
    // is dragged from its left edge as the sidebar's width is; widened, it
    // takes the whole split and the page steps aside.
    let wide = s.side_shown() && s.side.wide;
    // Widened with the sidebar folded, the panel reaches the window's left edge:
    // its tabs start past the traffic lights and the sidebar's buttons, 12
    // points after them as the header's breadcrumbs do (the card sits on the canvas inset).
    let strip_lead = if wide && !s.sidebar_open { shell::collapsed_slot_end(titlebar_inset) + 12.0 - inset } else { 10.0 };
    // Folded, the panel is parked just past the window's right edge rather than
    // removed: a removed element always fades out, and the page inside it is a
    // native view that cannot fade with it.
    let parked = !s.side_shown() && s.screen == crate::state::Screen::Workspace && (s.side_item() || s.side.browser.shown);
    let side_card = ((s.side_shown() || parked) && !s.side_panel_duplicates_page()).then(|| side::view(s, t, k, strip_lead));
    // The chat keeps the width it will have, and its column clips it while the
    // panel slides: shrinking with the column, its text re-wrapped every frame.
    let share = if s.side_shown() { (s.split_w * s.prefs.helper() / 100.0).round() } else { 0.0 };
    let chat_w = (s.split_w - share - if s.sidebar_open || wide { 0.0 } else { inset }).max(0.0);
    let panel = if s.split_w > 0.0 && chat_w > 0.0 { panel.w(chat_w).min_w(chat_w) } else { panel };
    let panel = col()
        .key("panel-column")
        .min_w(0.0)
        .h_full()
        .pt(inset)
        .pb(inset)
        .pr(if s.side_shown() { 0.0 } else { inset })
        .pl(if s.sidebar_open || wide { 0.0 } else { inset })
        .opacity(if wide { 0.0 } else { 1.0 })
        .clip_rounded(0.0)
        .child(panel);
    // The rows around the panel are always there, so opening a card beside it
    // or the agent pane only narrows it. Built only when needed, they would
    // move the panel to a new parent, and it would crossfade with a copy of itself.
    let mut split = row()
        .key("side-split")
        // Its own spring: the root's is none (themes swap at once), and inheriting
        // that landed the split mid-slide on the first commit after a change.
        .motion(SPLIT)
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        // Layout units already: the zoom scales the whole drawn tree, not its layout.
        .on_layout(|s: &mut App, r: [f32; 4]| s.split_w = r[2])
        // Its width moves on the split spring, the panel's offset on the same one:
        // the chat's edge and the panel's edge travel together.
        .child({
            let side_w = if s.side_shown() && s.split_w > 0.0 { if wide { s.split_w } else { (s.split_w * s.prefs.helper() / 100.0).round() } } else { 0.0 };
            let cw = (s.split_w - side_w).max(0.0);
            if s.split_w > 0.0 { panel.w(cw).min_w(cw).motion(SPLIT) } else { panel.grow(1.0).motion(SPLIT) }
        });
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
                // In from the right edge and back out, on the chat's spring, with no
                // fade: the page inside follows its drawn place (`follow_drawn`).
                .transition(Transition::offset(w.max(1.0), 0.0).springs(SpringPair::new(SPLIT, SPLIT)))
                // Pinned to the right; folded, it slides out past the edge by its width.
                .pin(None, Some(0.0), Some(0.0), Some(0.0))
                .offset(if parked { w } else { 0.0 }, 0.0)
                .w(w)
                // Held at its share: without it the panel's content outweighs it.
                .min_w(w)
                .motion(SPLIT)
                .h_full()
                .pt(inset)
                .pb(inset)
                // A strip of canvas between the main panel and the right card.
                .pl(if wide && !s.sidebar_open { inset } else if wide { 0.0 } else { 4.0 })
                .pr(inset)
                .child(card)
                .children((!wide).then(|| agent::side_edge("side"))),
        );
    }
    let mut ws = row().key("workspace").w_full().h_full();
    if s.sidebar_open {
        // It slides off the window's left edge on the spring the page follows it
        // with, so the two edges stay together; by default it would fade in place
        // over the page that had already moved under it.
        let spring = crate::state::SIDEBAR_SPRING;
        ws = ws.child(shell::sidebar(s, t).transition(Transition::offset(-s.prefs.sidebar(), 0.0).springs(SpringPair::new(spring, spring))));
    }
    ws = ws.child(split);
    ws
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

/// Confirmations and errors: a compact card in the top-right corner, not a full-width bar.
fn notice_toast(t: &Theme, text_: &str) -> El {
    const W: f32 = 380.0;
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
    shadows(
        col()
            .key("notice-toast")
            .pin(None, Some(12.0), Some(24.0), None)
            .w(W)
            .role("status")
            .label("Notification")
            .child(crate::ui::widgets::alert(t, "notice", None, body)),
        &t.float_shadow,
    )
}
