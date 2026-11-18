//! The right panel: a strip of tabs (the artifact or helper beside the chat,
//! and a browser) with its widen and fold buttons on the right, over the tab
//! in front. The browser is a native web view placed over its slot.

use rune::{Cursor, El, ScrollSpec, col, row, text_input};
use rune_kit::Kit;

use crate::icons;
use crate::native_preview::{self, BrowserCommand};
use crate::side::{Launch, SideTab};
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
        SideTab::Launcher => launcher(s, t),
        SideTab::Analytics | SideTab::Page(crate::state::Page::Overview) => col().key("side-analytics").w_full().grow(1.0).min_h(0.0).padding(8.0).child(super::overview::view(s, t, true)),
        SideTab::CampaignBrief => match s.campaign_editor {
            Some(_) => super::campaign_brief::view(s, t),
            None => empty(t, "campaign-document-closed", "This brief has been closed."),
        },
        SideTab::Page(crate::state::Page::Inbox) => super::pages::inbox_panel(s, t),
        SideTab::Page(crate::state::Page::Channels) => scrolled("side-connections", col().w_full().padding(20.0).child(super::channels::connections(s, t))),
        SideTab::Page(page) => scrolled("side-workspace-page", col().w_full().px(24.0).pt(16.0).pb(24.0).child(super::pages::view_page(s, t, *page))),
        SideTab::Files => files(s, t),
        SideTab::Changes => changes(s, t),
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
        // Over a page in the browser it floats on the page instead (`browser`);
        // the other tabs sit beside the main chat and need none.
        _ => false,
    };
    let business = s.active_business().map(|b| b.name.clone()).unwrap_or_default();
    ready.then(|| col().w_full().pt(8.0).child(super::agent::composer(s, t, &business, crate::state::ComposerSlot::Side)))
}

/// What a tab shows on the strip: its icon and name.
fn tab_face(s: &App, item: &SideTab) -> (&'static rune::Icon, String) {
    match item {
        SideTab::Artifact(id) => (&icons::FILE_TEXT, s.artifacts.iter().find(|p| &p.id == id).and_then(|p| p.loaded.ready()).map(|a| a.title.clone()).unwrap_or_else(|| "Artifact".into())),
        SideTab::Helper(id) => {
            let info = s.helpers.iter().find(|(h, _)| h == id).and_then(|(_, l)| l.ready()).and_then(|c| c.session.clone());
            let role = crate::chat::role_label(info.as_ref().and_then(|i| i.role.as_deref()).unwrap_or("general"));
            (&icons::USERS, info.and_then(|i| i.title).unwrap_or_else(|| format!("{role} helper")))
        }
        SideTab::Analytics => (&icons::NAV_ANALYTICS, "Analytics".into()),
        SideTab::CampaignBrief => (&icons::BRIEFCASE, "Campaign brief".into()),
        SideTab::Page(crate::state::Page::Campaigns) => (&icons::NAV_CAMPAIGNS, "Campaigns".into()),
        SideTab::Page(page) => (&icons::PANEL_RIGHT, page.label().into()),
        SideTab::Files => (&icons::FOLDER, "Files".into()),
        SideTab::Changes => (&icons::GIT_COMPARE, "Changes".into()),
        SideTab::Launcher => (&icons::PLUS, "New tab".into()),
        SideTab::Browser => (&icons::GLOBE, "Browser".into()),
    }
}

/// The tabs on the left, the browser's first once it is open, the rest in the
/// order they opened; widen and fold on the right. Level with the main header,
/// with no rule under it. When the panel is too narrow for names, each tab is
/// its icon alone, all the same size, with the one in front keeping its close.
fn strip(s: &App, t: &Theme, front: &SideTab, lead: f32) -> El {
    let web = if s.side.browser.shown { s.web_tabs() } else { Vec::new() };
    let launcher = *front == SideTab::Launcher;
    let count = web.len() + s.side_items().len() + usize::from(launcher);
    // The panel's width, as the split gives it (`ui::workspace`), less its insets.
    let panel = if s.side.wide { s.split_w } else { (s.split_w * s.prefs.helper() / 100.0).round() } - 12.0;
    // Lead, right pad, + and the widen and fold buttons, and the gaps between.
    let room = panel - lead - 10.0 - 3.0 * 28.0 - 4.0 * 2.0 - 8.0;
    let compact = s.split_w > 0.0 && count > 0 && room / count as f32 - 2.0 < 104.0;
    // Clipped, tall enough for the front tab's shadow, so a strip with more
    // tabs than room never runs under the buttons on its right.
    let mut tabs = row().h(40.0).px(2.0).gap(2.0).center_y().grow(1.0).min_w(0.0).clip_rounded(0.0).role("tablist").label("Panel tabs");
    let close_button = |key: String, act: Box<dyn Fn(&mut App)>| {
        row()
            .key(key)
            .size(18.0, 18.0)
            .radius(5.0)
            .center()
            .role("button")
            .label("Close tab")
            .help("Close (Esc)")
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .on_press(move |s: &mut App| act(s))
            .child(ico(&icons::X, 12.0, t.muted_foreground))
    };
    for (id, name, current) in web {
        let on = *front == SideTab::Browser && current;
        let close = on.then(|| close_button(format!("side-web-close-{id}"), Box::new(move |s: &mut App| s.close_web_tab(id))));
        tabs = tabs.child(tab_button(t, &format!("side-tab-browser-{id}"), &icons::GLOBE, &name, on, close, compact).on_press(move |s: &mut App| s.select_web_tab(id)));
    }
    for (i, item) in s.side_items().iter().enumerate() {
        let (icon, name) = tab_face(s, item);
        let on = front == item;
        let closing = item.clone();
        let close = on.then(|| close_button(format!("side-tab-close-{i}"), Box::new(move |s: &mut App| s.close_tab(&closing))));
        let showing = item.clone();
        tabs = tabs.child(tab_button(t, &format!("side-tab-{i}"), icon, &name, on, close, compact).on_press(move |s: &mut App| s.show_tab(showing.clone())));
    }
    if launcher {
        let close = Some(close_button("side-tab-close-new".into(), Box::new(|s: &mut App| s.close_tab(&SideTab::Launcher))));
        tabs = tabs.child(tab_button(t, "side-tab-new-list", &icons::PLUS, "New tab", true, close, compact));
    } else {
        tabs = tabs.child(icon_button(t, "side-tab-new", &icons::PLUS, "New tab", false).on_press(|s: &mut App| s.open_launcher()));
    }
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

/// A tab: its icon and name, or (compact) its icon alone in the middle of a
/// square, with room for the close beside it when it is the one in front.
fn tab_button(t: &Theme, key: &str, icon: &'static rune::Icon, name: &str, on: bool, close: Option<El>, compact: bool) -> El {
    let ink = if on { t.foreground } else { t.muted_foreground };
    let mut b = row()
        .key(key)
        .h(28.0)
        .radius(7.0)
        .center_y()
        .role("tab")
        .label(name.to_string())
        .help(name.to_string())
        .checked(on)
        .focusable(true)
        .cursor(Cursor::Pointer)
        .hover(t.hover_tint)
        .motion(CONTROL)
        .child(ico(icon, 14.0, ink));
    b = if compact {
        match close {
            // Even padding on both sides, the icon and its close as one pair.
            Some(c) => b.px(5.0).gap(2.0).child(c),
            None => b.w(28.0).center(),
        }
    } else {
        b.pl(8.0)
            .pr(if close.is_some() { 4.0 } else { 10.0 })
            .gap(6.0)
            .min_w(0.0)
            .max_w(220.0)
            .child(label(name.to_string(), if on { type_::XS_MEDIUM } else { type_::XS }, ink).truncate().min_w(0.0))
            .children(close)
    };
    if on {
        b = shadows(b.fill(t.accent), &t.control_shadow);
    }
    b
}

fn scrolled(key: &str, body: El) -> El {
    col().key(key).w_full().grow(1.0).min_h(0.0).child(body).scroll(ScrollSpec { stick_bottom: false })
}

/// Keep the opening list level with the main chat's starter cards.
fn launcher(s: &App, t: &Theme) -> El {
    let mut list = col().key("side-launch-list").w_full().max_w(420.0).gap(2.0);
    for what in Launch::ALL {
        let (icon, name, about): (&'static rune::Icon, &str, &str) = match what {
            Launch::Browser => (&icons::GLOBE, "Browser", "Websites and the chat's landing pages"),
            Launch::Changes => (&icons::GIT_COMPARE, "Changes", "What the agent changed, version by version"),
            Launch::Files => (&icons::FOLDER, "Files", "Pages, drafts and documents from this chat"),
            Launch::Analytics => (&icons::NAV_ANALYTICS, "Analytics", "The business's numbers beside the chat"),
            Launch::Campaigns => (&icons::NAV_CAMPAIGNS, "Campaigns", "Briefs, deliverables and results beside the chat"),
        };
        let hover_key = format!("launch:{}", name.to_lowercase());
        // Hovered, its icon takes the periwinkle Home's starters draw theirs in.
        let hovered = s.row_hover.as_deref() == Some(hover_key.as_str());
        list = list.child(super::widgets::highlight(t,
            row()
                .key(format!("side-launch-{}", name.to_lowercase()))
                .w_full()
                .max_w(360.0)
                .h(44.0)
                .pl(10.0)
                .pr(14.0)
                .gap(12.0)
                .radius(8.0)
                .on_hover_change(super::widgets::track_hover(hover_key))
                .center_y()
                .role("button")
                .label(name.to_string())
                .help(format!("{name}: {about}"))
                .disabled(what == Launch::Campaigns && (s.active.is_none() || s.general))
                .opacity(if what == Launch::Campaigns && (s.active.is_none() || s.general) { 0.4 } else { 1.0 })
                .focusable(true)
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut App| s.launch(what))
                .child(ico(icon, 16.0, if hovered { t.primary_ink } else { t.foreground }))
                .child(label(name.to_string(), type_::XS_MEDIUM, t.foreground).grow(1.0).min_w(0.0).truncate()),
            hovered, false));
    }
    col().key("side-launcher").w_full().grow(1.0).min_h(0.0)
        .child(col().w_full().px(24.0).pt(super::agent::home_stack_top(s)).pb(32.0)
            .child(row().w_full().h(super::agent::ROLL_H).center().child(list)))
        .scroll(ScrollSpec { stick_bottom: false })
}

fn empty(t: &Theme, key: &str, text: &str) -> El {
    col().key(key).w_full().grow(1.0).min_h(0.0).center().padding(24.0).child(label(text.to_string(), type_::XS, t.muted_foreground).wrap().max_w(360.0))
}

/// The chat's artifacts, one row each; a row opens it beside the chat.
fn files(s: &App, t: &Theme) -> El {
    let all = s.chat_artifacts();
    if all.is_empty() {
        return empty(t, "side-files-empty", "Nothing made in this chat yet. Pages, campaign drafts and documents the agent makes show here.");
    }
    let mut list = col().w_full().gap(2.0).px(12.0).py(12.0);
    for (i, r) in all.into_iter().enumerate() {
        let caption = r.caption();
        let icon: &'static rune::Icon = if crate::artifacts::is_page(&r.kind) { &icons::GLOBE } else { &icons::FILE_TEXT };
        let title = if r.title.is_empty() { "Untitled".to_string() } else { r.title.clone() };
        list = list.child(
            row()
                .key(format!("side-file-{i}"))
                .w_full()
                .h(44.0)
                .px(10.0)
                .gap(12.0)
                .radius(8.0)
                .center_y()
                .role("button")
                .label(title.clone())
                .focusable(true)
                .cursor(Cursor::Pointer)
                .hover(t.hover_tint)
                .on_press(move |s: &mut App| s.open_file(&r))
                .child(ico(icon, 15.0, t.muted_foreground))
                .child(col().grow(1.0).min_w(0.0).child(label(title, type_::XS_MEDIUM, t.foreground).truncate()).child(label(caption, type_::XS, t.muted_foreground).truncate())),
        );
    }
    scrolled("side-files", list)
}

/// What changed: the chat's artifacts on the left of a picker, and the one
/// chosen, its latest version set against the one before, line by line.
fn changes(s: &App, t: &Theme) -> El {
    let all = s.chat_artifacts();
    if all.is_empty() {
        return empty(t, "side-changes-empty", "No changes yet. When the agent edits a page or a draft in this chat, what changed shows here.");
    }
    let chosen = s.side.diff.as_ref().map(|d| d.id.clone());
    let mut pick = row().key("side-changes-pick").w_full().gap(4.0).px(12.0).pt(12.0).flex_wrap();
    for (i, r) in all.iter().enumerate() {
        let on = chosen.as_deref() == Some(r.id.as_str());
        let (id, title) = (r.id.clone(), if r.title.is_empty() { "Untitled".to_string() } else { r.title.clone() });
        let mut chip = row()
            .key(format!("side-change-{i}"))
            .h(26.0)
            .px(10.0)
            .gap(6.0)
            .radius(13.0)
            .center_y()
            .max_w(240.0)
            .border(1.0, t.border)
            .role("tab")
            .checked(on)
            .label(title.clone())
            .cursor(Cursor::Pointer)
            .hover(t.hover_tint)
            .on_press(move |s: &mut App| s.show_diff(&id))
            .child(label(if r.title.is_empty() { "Untitled".to_string() } else { r.title.clone() }, type_::XS, if on { t.foreground } else { t.muted_foreground }).truncate().min_w(0.0))
            .child(label(format!("v{}", r.version), type_::XS, t.muted_foreground));
        if on {
            chip = chip.fill(t.accent);
        }
        pick = pick.child(chip);
    }
    let body = match s.side.diff.as_ref() {
        None => empty(t, "side-changes-pick-one", "Pick a page or draft to see what its latest version changed."),
        Some(d) => match &d.lines {
            crate::state::Load::Ready((from, to, lines)) => {
                let (added, removed) = lines.iter().fold((0, 0), |(a, r), l| match l {
                    crate::changes::Line::Added(_) => (a + 1, r),
                    crate::changes::Line::Removed(_) => (a, r + 1),
                    _ => (a, r),
                });
                let head = if *from == 0 { format!("v{to}, the first version") } else { format!("v{from} to v{to}: {added} added, {removed} removed") };
                let mut out = col().w_full().gap(1.0).px(12.0).pb(16.0).child(label(head, type_::XS_MEDIUM, t.muted_foreground).py(8.0));
                // Unchanged runs fold to their first and last line, so the changes stand out.
                let mut i = 0;
                while i < lines.len() {
                    let run = lines[i..].iter().take_while(|l| matches!(l, crate::changes::Line::Same(_))).count();
                    if run > 4 {
                        out = out.child(diff_line(t, &lines[i])).child(label(format!("{} unchanged lines", run - 2), type_::XS, t.muted_foreground).px(8.0).py(2.0)).child(diff_line(t, &lines[i + run - 1]));
                        i += run;
                    } else {
                        out = out.child(diff_line(t, &lines[i]));
                        i += 1;
                    }
                }
                if added + removed == 0 {
                    out = out.child(label("The words are the same; only the layout or style changed.", type_::XS, t.muted_foreground).py(8.0));
                }
                scrolled("side-diff", out)
            }
            crate::state::Load::Failed(e) => empty(t, "side-diff-failed", e),
            _ => empty(t, "side-diff-loading", "Comparing versions…"),
        },
    };
    col().key("side-changes").w_full().grow(1.0).min_h(0.0).child(pick).child(body)
}

fn diff_line(t: &Theme, l: &crate::changes::Line) -> El {
    use crate::changes::Line;
    let (mark, text, ink, fill) = match l {
        Line::Same(x) => (" ", x, t.muted_foreground, None),
        Line::Added(x) => ("+", x, t.foreground, Some(t.supported_soft)),
        Line::Removed(x) => ("−", x, t.muted_foreground, Some(t.wrong_soft)),
    };
    let mut r = row()
        .w_full()
        .px(8.0)
        .py(3.0)
        .gap(8.0)
        .radius(4.0)
        .child(label(mark.to_string(), type_::XS_MEDIUM, if matches!(l, Line::Added(_)) { t.supported } else if matches!(l, Line::Removed(_)) { t.wrong } else { t.muted_foreground }).w(10.0))
        .child(label(text.clone(), type_::XS, ink).wrap().grow(1.0).min_w(0.0));
    if let Some(f) = fill {
        r = r.fill(f);
    }
    r
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
    // Typing an address only while the field still has focus: a click
    // anywhere else puts the page's name back.
    let address: El = if (b.editing && b.address.focused) || !open {
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
        let hover_key = format!("browser-recent-{i}");
        let hovered = s.row_hover.as_deref() == Some(hover_key.as_str());
        list = list.child(super::widgets::highlight(t,
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
                .on_hover_change(super::widgets::track_hover(hover_key))
                .on_press(move |s: &mut App| s.browser_go(&go))
                .child(ico(&icons::GLOBE, 14.0, t.muted_foreground))
                .child(label(name, type_::XS_MEDIUM, t.foreground).truncate().min_w(0.0))
                .child(label(url, type_::XS, t.muted_foreground).truncate().grow(1.0).min_w(0.0)),
            hovered, false));
    }
    // In the middle of the tab, across and down.
    col().w_full().grow(1.0).min_h(0.0).center().px(24.0).py(24.0).child(list)
}

pub fn host(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/').next().unwrap_or(rest).trim_start_matches("www.").to_string()
}
