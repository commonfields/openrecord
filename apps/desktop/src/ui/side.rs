//! The right panel: a strip of tabs (the artifact or helper beside the chat,
//! and a browser) with its widen and fold buttons on the right, over the tab
//! in front. The browser is a native web view placed over its slot.

use rune::{Cursor, El, col, row, text_input};
use rune_kit::Kit;

use crate::icons;
use crate::native_preview::{self, BrowserCommand};
use crate::side::SideTab;
use crate::state::App;
use crate::theme::{Theme, shadows, type_};
use crate::ui::widgets::{CONTROL, ico, icon_button, label};

/// The button that opens or folds the right panel (⌥⌘B), at a header's right end.
pub fn toggle(t: &Theme, open: bool) -> El {
    icon_button(t, "side-toggle", &icons::PANEL_RIGHT, if open { "Collapse panel (⌥⌘B)" } else { "Open panel (⌥⌘B)" }, false).on_press(|s: &mut App| s.toggle_side())
}

pub fn view(s: &App, t: &Theme, k: &Kit, lead: f32) -> El {
    let tab = s.side_tab();
    let body = match &tab {
        SideTab::Artifact(_) => super::artifacts::view(s, t),
        SideTab::Helper(_) => match s.front_helper() {
            Some((id, load)) => super::agent::helper_pane(s, t, k, id, load),
            None => browser(s, t),
        },
        SideTab::Browser => browser(s, t),
    };
    // A page open in the browser runs to the panel's foot: the page is drawn
    // behind the app, so the panel paints only its top band and leaves the
    // rest clear, the chat box floating over the page.
    if s.browser_page_shown() {
        return col()
            .key("side-panel")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .radius(10.0)
            .clip_rounded(10.0)
            .role("complementary")
            .label("Side panel")
            .child(strip(s, t, &tab, lead).fill(t.background))
            .child(col().w_full().grow(1.0).min_h(0.0).child(body));
    }
    shadows(
        col()
            .key("side-panel")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .radius(10.0)
            .fill(t.background)
            .clip_rounded(10.0)
            .role("complementary")
            .label("Side panel")
            .child(strip(s, t, &tab, lead))
            .child(col().w_full().grow(1.0).min_h(0.0).child(body))
            .children(chat_box(s, t, &tab)),
        &t.panel_shadow,
    )
}

/// Under an artifact or a helper, the main chat box, the same in look and use,
/// where the main chat has its own.
fn chat_box(s: &App, t: &Theme, tab: &SideTab) -> Option<El> {
    let ready = match tab {
        SideTab::Artifact(_) => s.front_artifact().is_some_and(|p| p.loaded.ready().is_some()),
        SideTab::Helper(_) => s.front_helper().is_some(),
        // Over a page in the browser it floats on the page instead (`browser`).
        SideTab::Browser => false,
    };
    let business = s.active_business().map(|b| b.name.clone()).unwrap_or_default();
    ready.then(|| col().w_full().pt(8.0).child(super::agent::composer(s, t, &business, crate::state::ComposerSlot::Side)))
}

/// The tabs on the left, the browser pinned first and the chat's artifacts and
/// helpers after it in the order they opened; widen and fold on the right.
/// Level with the main header, with no rule under it.
fn strip(s: &App, t: &Theme, front: &SideTab, lead: f32) -> El {
    let mut tabs = row().gap(2.0).center_y().grow(1.0).min_w(0.0).role("tablist").label("Panel tabs");
    // The browser's tabs first, each its own page; more open with the + after them.
    let web = s.web_tabs();
    let several = web.len() > 1;
    for (id, name, current) in web {
        let close = several.then(|| {
            row()
                .key(format!("side-web-close-{id}"))
                .size(18.0, 18.0)
                .radius(5.0)
                .center()
                .role("button")
                .label("Close tab")
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.close_web_tab(id))
                .child(ico(&icons::X, 12.0, t.muted_foreground))
        });
        tabs = tabs.child(tab_button(t, &format!("side-tab-browser-{id}"), &icons::GLOBE, &name, *front == SideTab::Browser && current, close).on_press(move |s: &mut App| s.select_web_tab(id)));
    }
    for (i, item) in s.side_items().iter().enumerate() {
        let (icon, name): (&'static rune::Icon, String) = match item {
            SideTab::Artifact(id) => (
                &icons::FILE_TEXT,
                s.artifacts.iter().find(|p| &p.id == id).and_then(|p| p.loaded.ready()).map(|a| a.title.clone()).unwrap_or_else(|| "Artifact".into()),
            ),
            SideTab::Helper(id) => {
                let info = s.helpers.iter().find(|(h, _)| h == id).and_then(|(_, l)| l.ready()).and_then(|c| c.session.clone());
                let role = crate::chat::role_label(info.as_ref().and_then(|i| i.role.as_deref()).unwrap_or("general"));
                (&icons::USERS, info.and_then(|i| i.title).unwrap_or_else(|| format!("{role} helper")))
            }
            SideTab::Browser => continue,
        };
        let closing = item.clone();
        let close = row()
            .key(format!("side-tab-close-{i}"))
            .size(18.0, 18.0)
            .radius(5.0)
            .center()
            .role("button")
            .label("Close tab")
            .help("Close (Esc)")
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .on_press(move |s: &mut App| s.close_tab(&closing))
            .child(ico(&icons::X, 12.0, t.muted_foreground));
        let showing = item.clone();
        tabs = tabs.child(tab_button(t, &format!("side-tab-{i}"), icon, &name, front == item, Some(close)).on_press(move |s: &mut App| s.show_tab(showing.clone())));
    }
    tabs = tabs.child(icon_button(t, "side-tab-new", &icons::PLUS, "New tab", false).on_press(|s: &mut App| s.new_web_tab()));
    let wide = s.side.wide;
    row()
        .key("side-strip")
        .w_full()
        .h(48.0)
        .pl(lead)
        .motion(super::widgets::CONTROL)
        .pr(10.0)
        .gap(4.0)
        .center_y()
        .window_drag()
        .child(tabs)
        .child(
            icon_button(t, "side-wide", if wide { &icons::MINIMIZE_2 } else { &icons::MAXIMIZE_2 }, if wide { "Restore panel width" } else { "Expand panel" }, false)
                .on_press(|s: &mut App| s.side.wide = !s.side.wide),
        )
        .child(toggle(t, true))
}

fn tab_button(t: &Theme, key: &str, icon: &'static rune::Icon, name: &str, on: bool, close: Option<El>) -> El {
    let ink = if on { t.foreground } else { t.muted_foreground };
    let mut b = row()
        .key(key)
        .h(28.0)
        .pl(8.0)
        .pr(if close.is_some() { 4.0 } else { 10.0 })
        .gap(6.0)
        .min_w(0.0)
        .max_w(220.0)
        .radius(7.0)
        .center_y()
        .role("tab")
        .label(name.to_string())
        .checked(on)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .motion(CONTROL)
        .child(ico(icon, 14.0, ink))
        .child(label(name.to_string(), if on { type_::XS_MEDIUM } else { type_::XS }, ink).truncate().min_w(0.0))
        .children(close);
    if on {
        b = shadows(b.fill(t.accent), &t.control_shadow);
    }
    b
}

/// The browser: back, forward, reload and the address on one line, the page
/// (or, before one is open, a start list) under it.
fn browser(s: &App, t: &Theme) -> El {
    let b = &s.side.browser;
    let open = b.url.is_some();
    let (back, forward, loading) = if open { native_preview::browser_state() } else { (false, false, false) };
    let nav = |key: &str, icon: &'static rune::Icon, name: &str, enabled: bool| {
        icon_button(t, key, icon, name, false).disabled(!enabled).opacity(if enabled { 1.0 } else { 0.4 })
    };
    let address: El = if b.editing || !open {
        text_input(&b.address, type_::XS)
            .key("browser-address")
            .placeholder("Search or enter address", t.muted_foreground)
            .label("Address")
            .w_full()
            .color(t.foreground)
            .on_edit(|s: &mut App| &mut s.side.browser.address)
            .on_submit(|s: &mut App, _tx| {
                let text = s.side.browser.address.text.clone();
                s.browser_go(&text);
            })
    } else {
        // A landing page from the chat shows its title, not where its copy sits on disk.
        let now = match s.browser_artifact().and_then(|p| p.loaded.ready()) {
            Some(a) => a.title.clone(),
            None => native_preview::browser_url().or_else(|| b.url.clone()).unwrap_or_default(),
        };
        label(now, type_::XS, t.muted_foreground)
            .key("browser-address-shown")
            .w_full()
            .truncate()
            .role("button")
            .label("Edit address")
            .cursor(Cursor::Text)
            .on_press_tx(|s: &mut App, tx| s.edit_address(tx))
    };
    let field = row()
        .grow(1.0)
        .min_w(0.0)
        .h(30.0)
        .px(12.0)
        .gap(8.0)
        .radius(15.0)
        .center_y()
        .fill(t.foreground.alpha(0.05))
        .border(1.0, t.border)
        .child(ico(&icons::SEARCH, 13.0, t.muted_foreground))
        .child(col().grow(1.0).min_w(0.0).child(address));
    let bar = row()
        .w_full()
        .h(44.0)
        .fill(t.background)
        .px(8.0)
        .gap(2.0)
        .center_y()
        .child(nav("browser-back", &icons::ARROW_LEFT, "Back", back).on_press(|s: &mut App| s.browser_command(BrowserCommand::Back)))
        .child(nav("browser-forward", &icons::ARROW_RIGHT, "Forward", forward).on_press(|s: &mut App| s.browser_command(BrowserCommand::Forward)))
        .child(if loading {
            nav("browser-stop", &icons::X, "Stop loading", true).on_press(|s: &mut App| s.browser_command(BrowserCommand::Stop))
        } else {
            nav("browser-reload", &icons::REFRESH_CW, "Reload", open).on_press(|s: &mut App| s.browser_command(BrowserCommand::Reload))
        })
        .child(field.ml(6.0))
        .children(open.then(|| {
            // The page's own zoom: the app around it stays as it is.
            let z = if b.zoom > 0.0 { b.zoom } else { 1.0 };
            row()
                .ml(4.0)
                .gap(0.0)
                .center_y()
                .child(icon_button(t, "browser-zoom-out", &icons::MINUS, "Zoom out of the page", false).on_press(|s: &mut App| s.zoom_page(-1)))
                .child(
                    row()
                        .key("browser-zoom-reset")
                        .w(40.0)
                        .h(28.0)
                        .center()
                        .child(label(format!("{}%", (z * 100.0).round() as i32), type_::XS, t.muted_foreground))
                        .role("button")
                        .label("Reset page zoom")
                        .help("Actual size")
                        .cursor(Cursor::Pointer)
                        .on_press(|s: &mut App| s.zoom_page(0)),
                )
                .child(icon_button(t, "browser-zoom-in", &icons::PLUS, "Zoom in on the page", false).on_press(|s: &mut App| s.zoom_page(1)))
        }))
        .children(open.then(|| icon_button(t, "browser-home", &icons::X, "Close page", false).on_press(|s: &mut App| s.browser_home())));

    let page = if open {
        // Clear while the page shows (it is behind the app); white while it is
        // put away for a menu or dialog over it.
        let shown = s.browser_visible();
        let mut page = col()
            .key("browser-page")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .on_drawn_layout(|s: &mut App, r: [f32; 4]| {
                s.side.browser.rect = Some(r);
                if s.browser_artifact().is_none() {
                    native_preview::browser_keep(&[]);
                }
                if s.browser_visible() {
                    let pending = s.side.browser.pending.take();
                    native_preview::browser_show(pending.as_deref(), r);
                }
            });
        if !shown {
            page = page.fill(rune::Color::WHITE).child(label("Loading…", type_::XS, t.muted_foreground).padding(20.0));
        }
        // A landing page from the chat: the chat box floats over its foot.
        if s.browser_artifact().is_some() {
            let business = s.active_business().map(|b| b.name.clone()).unwrap_or_default();
            // The chat box takes the page's look: light over a light page, dark over a dark one.
            let owned;
            let ct: &Theme = match native_preview::browser_page_light() {
                Some(light) => {
                    owned = Theme::get(!light);
                    &owned
                }
                None => t,
            };
            page = page.child(
                col()
                    .key("browser-chat")
                    // The chat box and its details on the page itself, no card behind them.
                    .pin(Some(0.0), None, Some(0.0), Some(0.0))
                    .on_drawn_layout(|_: &mut App, r: [f32; 4]| native_preview::browser_keep(&[r]))
                    .child(super::agent::composer(s, ct, &business, crate::state::ComposerSlot::Side)),
            );
        }
        page
    } else {
        start(s, t)
    };
    col().key("browser").w_full().grow(1.0).min_h(0.0).child(bar).child(page)
}

/// Before a page is open: the web app and the pages opened this session.
fn start(s: &App, t: &Theme) -> El {
    let web = super::web_url(&crate::state::api_base());
    let mut items: Vec<(String, String)> = vec![("OpenRecord on the web".into(), web)];
    for u in &s.side.browser.recents {
        if !items.iter().any(|(_, x)| x == u) {
            items.push((host(u), u.clone()));
        }
    }
    let mut list = col().w_full().max_w(520.0).gap(2.0).child(label("Recents", type_::XS_MEDIUM, t.muted_foreground).px(10.0).pb(6.0));
    for (i, (name, url)) in items.into_iter().enumerate() {
        let go = url.clone();
        list = list.child(
            row()
                .key(format!("browser-recent-{i}"))
                .w_full()
                .h(32.0)
                .px(10.0)
                .gap(10.0)
                .radius(7.0)
                .center_y()
                .role("link")
                .label(name.clone())
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.browser_go(&go))
                .child(ico(&icons::GLOBE, 14.0, t.muted_foreground))
                .child(label(name, type_::XS_MEDIUM, t.foreground).truncate().min_w(0.0))
                .child(label(url, type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0)),
        );
    }
    // In the middle of the tab, across and down.
    col().w_full().grow(1.0).min_h(0.0).center().px(24.0).py(24.0).child(list)
}

pub fn host(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/').next().unwrap_or(rest).trim_start_matches("www.").to_string()
}
