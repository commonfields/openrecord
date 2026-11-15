//! The right panel: a strip of tabs (the artifact or helper beside the chat,
//! and a browser) with its widen and fold buttons on the right, over the tab
//! in front. The browser is a native web view placed over its slot.

use rune::{Cursor, El, ScrollSpec, col, el, row, text_input};
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

pub fn view(s: &App, t: &Theme, k: &Kit) -> El {
    let tab = s.side_tab();
    let body = match tab {
        SideTab::Item if s.artifact.is_some() => super::artifacts::view(s, t).w_full().grow(1.0).min_h(0.0),
        SideTab::Item => match &s.helper {
            Some((id, load)) => super::agent::helper_pane(s, t, k, id, load),
            None => browser(s, t),
        },
        SideTab::Browser => browser(s, t),
    };
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
            .child(strip(s, t, tab))
            .child(el().w_full().h(1.0).fill(t.border))
            .child(col().w_full().grow(1.0).min_h(0.0).child(body)),
        &t.panel_shadow,
    )
}

/// The tabs on the left; widen and fold on the right. Level with the main header.
fn strip(s: &App, t: &Theme, tab: SideTab) -> El {
    let mut tabs = row().gap(2.0).center_y().grow(1.0).min_w(0.0).role("tablist").label("Panel tabs");
    if s.side_item() {
        let (icon, name): (&'static rune::Icon, String) = if let Some(a) = &s.artifact {
            (&icons::FILE_TEXT, a.loaded.ready().map(|a| a.title.clone()).unwrap_or_else(|| "Artifact".into()))
        } else {
            (&icons::USERS, "Helper".into())
        };
        let close = row()
            .key("side-item-close")
            .size(18.0, 18.0)
            .radius(5.0)
            .center()
            .role("button")
            .label("Close (Esc)")
            .help("Close (Esc)")
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .on_press(|s: &mut App| s.close_side_item())
            .child(ico(&icons::X, 12.0, t.muted_foreground));
        tabs = tabs.child(tab_button(t, "side-tab-item", icon, &name, tab == SideTab::Item, Some(close)).on_press(|s: &mut App| s.side.tab = SideTab::Item));
    }
    tabs = tabs.child(tab_button(t, "side-tab-browser", &icons::GLOBE, "Browser", tab == SideTab::Browser, None).on_press(|s: &mut App| s.show_browser_tab()));
    let wide = s.side.wide;
    row()
        .key("side-strip")
        .w_full()
        .h(48.0)
        .pl(10.0)
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
        let now = native_preview::browser_url().or_else(|| b.url.clone()).unwrap_or_default();
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
        .children(open.then(|| icon_button(t, "browser-home", &icons::X, "Close page", false).on_press(|s: &mut App| s.browser_home())));

    let page = if open {
        col()
            .key("browser-page")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .fill(rune::Color::WHITE)
            .on_drawn_layout(|s: &mut App, r: [f32; 4]| {
                s.side.browser.rect = Some(r);
                if s.browser_visible() {
                    let pending = s.side.browser.pending.take();
                    native_preview::browser_show(pending.as_deref(), r);
                }
            })
            .child(label("Loading…", type_::XS, t.muted_foreground).padding(20.0))
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
    col().w_full().grow(1.0).min_h(0.0).items_center().px(24.0).pt(40.0).child(list).scroll(ScrollSpec { stick_bottom: false })
}

fn host(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/').next().unwrap_or(rest).trim_start_matches("www.").to_string()
}
